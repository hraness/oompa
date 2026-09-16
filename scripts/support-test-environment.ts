// General tests must not read personal Git email or write suite invitation state.
// Focused support tests pass an explicit isolated environment to opt back in.
process.env.HRANESS_SUPPORT_AUDIENCE = "off";
process.env.HRANESS_SUPPORT_EMAIL = "off";
