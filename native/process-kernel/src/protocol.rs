//! Bounded inert wire decoding. This module performs no native operations.
#![forbid(unsafe_code)]

use serde::{Deserialize, Deserializer};
use std::collections::BTreeMap;

pub const LAUNCH_LIMIT: usize = 256 * 1024;
pub const WRITE_LIMIT: usize = 64 * 1024 * 1024;
pub const OUTPUT_CHUNK: usize = 65_536;
pub const STREAM_QUEUE_LIMIT: usize = 1024 * 1024;
pub const CONTROL_QUEUE_LIMIT: usize = 64 * 4096;
pub const FRAME_ASSEMBLY_MS: u64 = 30_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    InvalidLaunch,
    InvalidFrame,
    UnsupportedScope,
    SpawnFailed,
    WriteFailed,
    OutputFailed,
    ControllerLost,
    Deadline,
    CleanupUnproven,
}

impl Failure {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidLaunch => "invalid-launch",
            Self::InvalidFrame => "invalid-frame",
            Self::UnsupportedScope => "unsupported-scope",
            Self::SpawnFailed => "spawn-failed",
            Self::WriteFailed => "write-failed",
            Self::OutputFailed => "output-failed",
            Self::ControllerLost => "controller-lost",
            Self::Deadline => "deadline",
            Self::CleanupUnproven => "cleanup-unproven",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Launch {
    pub version: u32,
    pub nonce: String,
    pub scope: String,
    pub argv: Vec<String>,
    pub cwd: String,
    #[serde(deserialize_with = "environment")]
    pub environment: BTreeMap<String, String>,
    pub term_grace_ms: u64,
    pub settlement_ms: u64,
    pub write_timeout_ms: u64,
}

fn environment<'de, D: Deserializer<'de>>(
    decoder: D,
) -> Result<BTreeMap<String, String>, D::Error> {
    struct Visitor;
    impl<'de> serde::de::Visitor<'de> for Visitor {
        type Value = BTreeMap<String, String>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("bounded environment")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> Result<Self::Value, M::Error> {
            let mut result = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, String>()? {
                if result.len() >= 256 || result.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom("invalid environment"));
                }
            }
            Ok(result)
        }
    }
    decoder.deserialize_map(Visitor)
}

impl Launch {
    pub fn parse(bytes: &[u8]) -> Result<Self, Failure> {
        if bytes.len() > LAUNCH_LIMIT {
            return Err(Failure::InvalidLaunch);
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| Failure::InvalidLaunch)?;
        let valid_string = |s: &str| s.len() <= 32 * 1024 && !s.contains('\0');
        if value.version != 1
            || value.nonce.len() != 32
            || !value
                .nonce
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || !(1..=256).contains(&value.argv.len())
            || value.scope.len() > 64
            || !value.argv.iter().all(|s| valid_string(s))
            || !std::path::Path::new(&value.argv[0]).is_absolute()
            || !valid_string(&value.cwd)
            || !std::path::Path::new(&value.cwd).is_absolute()
            || !value.environment.iter().all(|(key, val)| {
                !key.is_empty()
                    && valid_string(key)
                    && valid_string(val)
                    && key.bytes().enumerate().all(|(index, byte)| {
                        byte == b'_'
                            || byte.is_ascii_alphabetic()
                            || (index > 0 && byte.is_ascii_digit())
                    })
            })
            || !(1..=30_000).contains(&value.term_grace_ms)
            || !(1..=30_000).contains(&value.settlement_ms)
            || !(1..=60_000).contains(&value.write_timeout_ms)
        {
            return Err(Failure::InvalidLaunch);
        }
        Ok(value)
    }
}

pub struct Frame {
    pub kind: u8,
    pub body: Vec<u8>,
}

/// Reads only the current frame. An oversized body is rejected from its header,
/// before any allocation or provider write. No following-frame bytes are hidden.
#[derive(Default)]
pub struct Decoder {
    header: [u8; 5],
    header_used: usize,
    body: Vec<u8>,
    body_used: usize,
}

impl Decoder {
    #[cfg(test)]
    pub fn partial(&self) -> bool {
        self.header_used != 0
    }

    pub fn writable(&mut self) -> &mut [u8] {
        if self.header_used < 5 {
            &mut self.header[self.header_used..]
        } else {
            &mut self.body[self.body_used..]
        }
    }

    pub fn advance(&mut self, count: usize, permit_write: bool) -> Result<Option<Frame>, Failure> {
        if self.header_used < 5 {
            self.header_used += count;
            if self.header_used < 5 {
                return Ok(None);
            }
            let length = u32::from_be_bytes(self.header[1..5].try_into().unwrap()) as usize;
            let valid = match self.header[0] {
                1 => length <= LAUNCH_LIMIT,
                2 => permit_write && (4..=WRITE_LIMIT + 4).contains(&length),
                3..=6 => length == 0,
                _ => false,
            };
            if !valid {
                return Err(Failure::InvalidFrame);
            }
            self.body = vec![0; length];
        } else {
            self.body_used += count;
        }
        if self.header_used == 5 && self.body_used == self.body.len() {
            let kind = self.header[0];
            let body = std::mem::take(&mut self.body);
            self.header_used = 0;
            self.body_used = 0;
            return Ok(Some(Frame { kind, body }));
        }
        Ok(None)
    }
}

pub fn encode(kind: u8, body: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(body.len() + 5);
    result.push(kind);
    result.extend_from_slice(&(body.len() as u32).to_be_bytes());
    result.extend_from_slice(body);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoder_preserves_each_fragment_and_rejects_oversized_header() {
        for length in [0, 1, 2, 31, OUTPUT_CHUNK] {
            let bytes = vec![0x9b; length];
            let input = encode(1, &bytes);
            for split in 1..=7 {
                let mut decoder = Decoder::default();
                let mut offset = 0;
                let mut output = None;
                while offset < input.len() {
                    let count = decoder
                        .writable()
                        .len()
                        .min(split)
                        .min(input.len() - offset);
                    decoder.writable()[..count].copy_from_slice(&input[offset..offset + count]);
                    offset += count;
                    output = decoder.advance(count, true).unwrap().or(output);
                }
                assert_eq!(output.unwrap().body, bytes);
                assert!(!decoder.partial());
            }
        }
        for (kind, length) in [(1, LAUNCH_LIMIT + 1), (2, WRITE_LIMIT + 5), (3, 1), (7, 0)] {
            let mut decoder = Decoder::default();
            decoder.writable().copy_from_slice(&encode(kind, &[])[..5]);
            decoder.header[1..].copy_from_slice(&(length as u32).to_be_bytes());
            assert_eq!(decoder.advance(5, true).err(), Some(Failure::InvalidFrame));
            assert!(decoder.body.is_empty());
        }
    }

    #[test]
    fn launch_rejects_duplicate_keys_unknown_fields_and_secret_reflection() {
        let valid = r#"{"version":1,"nonce":"0123456789abcdef0123456789abcdef","scope":"posix-process-group","argv":["/bin/true"],"cwd":"/","environment":{},"termGraceMs":1,"settlementMs":1,"writeTimeoutMs":1}"#;
        assert!(Launch::parse(valid.as_bytes()).is_ok());
        for text in [
            valid.replace("\"version\":1", "\"version\":1,\"version\":1"),
            valid.replace(
                "\"environment\":{}",
                "\"environment\":{\"X\":\"secret\",\"X\":\"other\"}",
            ),
            valid.replace("\"version\":1", "\"secret\":true,\"version\":1"),
            valid.replace("/bin/true", "relative"),
            valid.replace("\"termGraceMs\":1", "\"termGraceMs\":0"),
        ] {
            assert_eq!(
                Launch::parse(text.as_bytes()).err(),
                Some(Failure::InvalidLaunch)
            );
        }
    }
}
