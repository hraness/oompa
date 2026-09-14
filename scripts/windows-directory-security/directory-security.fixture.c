/* One fixed, credential-free Windows test. No command/path argument accepted. */
#include "directory-security.h"
#if defined(OOMPA_AMBIENT_CL_MUST_NOT_REACH_COMPILER) || defined(OOMPA_AMBIENT_CL_TAIL_MUST_NOT_REACH_COMPILER)
#error Ambient compiler options reached the fixed fixture
#endif
#include <aclapi.h>
#include <winioctl.h>
#include <objbase.h>
#include <stdio.h>
#include <string.h>
#include <stdint.h>

#define REQUIRE(x) do { if (!(x)) { failed_line = __LINE__; goto cleanup; } } while (0)
#define CASE() do { cases++; } while (0)
static unsigned long opened_handles, closed_handles;
static int failed_line;
static int close_owned(HANDLE *h) {
  if (*h == NULL || *h == INVALID_HANDLE_VALUE) return 1;
  if (!CloseHandle(*h)) return 0;
  *h = INVALID_HANDLE_VALUE; closed_handles++; return 1;
}
static HANDLE open_directory(const WCHAR *path) {
  HANDLE h = CreateFileW(path, READ_CONTROL | FILE_READ_ATTRIBUTES | WRITE_DAC | DELETE,
    FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (h != INVALID_HANDLE_VALUE) opened_handles++;
  return h;
}
static HANDLE open_peer_directory(const WCHAR *path) {
  HANDLE h = CreateFileW(path, READ_CONTROL | FILE_READ_ATTRIBUTES | WRITE_DAC,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (h != INVALID_HANDLE_VALUE) opened_handles++;
  return h;
}
static int close_binding(wd_binding **b) {
  if (*b == NULL) return 1;
  if (wd_close(b) != WD_OK) return 0;
  closed_handles++; return 1;
}
/* Windows may report either sharing violation or access denied when an open
 * directory handle fences rename/removal. Both are refusal outcomes; any
 * success, or another error, remains a fixture failure. */
static int delete_refused(void) {
  DWORD error = GetLastError();
  return error == ERROR_SHARING_VIOLATION || error == ERROR_ACCESS_DENIED;
}
static int make_path(WCHAR *out, const WCHAR *root, const WCHAR *name) {
  return swprintf_s(out, MAX_PATH, L"%s\\%s", root, name) > 0;
}
static int acl_for(unsigned char *storage, DWORD length, PSID sid, BYTE flags) {
  DWORD bytes = (DWORD)sizeof(ACL) + (DWORD)sizeof(ACCESS_ALLOWED_ACE) - (DWORD)sizeof(DWORD) + GetLengthSid(sid);
  return bytes <= length && InitializeAcl((PACL)storage, bytes, ACL_REVISION)
    && AddAccessAllowedAceEx((PACL)storage, ACL_REVISION, flags, WD_SELF_RIGHTS, sid);
}
static int create_private(const WCHAR *path, PSID user) {
  unsigned char acl[128]; SECURITY_DESCRIPTOR sd;
  SECURITY_ATTRIBUTES sa = { sizeof(sa), &sd, FALSE };
  return acl_for(acl, sizeof(acl), user, 0)
    && InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION)
    && SetSecurityDescriptorOwner(&sd, user, FALSE)
    && SetSecurityDescriptorDacl(&sd, TRUE, (PACL)acl, FALSE)
    && SetSecurityDescriptorControl(&sd, SE_DACL_PROTECTED, SE_DACL_PROTECTED)
    && CreateDirectoryW(path, &sa);
}
static int set_acl(HANDLE h, PSID user, BYTE flags, int protected_acl, int null_acl) {
  unsigned char acl[128];
  if (!null_acl && !acl_for(acl, sizeof(acl), user, flags)) return 0;
  return SetSecurityInfo(h, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION
    | (protected_acl ? PROTECTED_DACL_SECURITY_INFORMATION : UNPROTECTED_DACL_SECURITY_INFORMATION),
    NULL, NULL, null_acl ? NULL : (PACL)acl, NULL) == ERROR_SUCCESS;
}
static void put16(unsigned char *p, unsigned int n) { p[0] = (unsigned char)n; p[1] = (unsigned char)(n >> 8); }
static void put32(unsigned char *p, uint32_t n) {
  p[0] = (unsigned char)n; p[1] = (unsigned char)(n >> 8);
  p[2] = (unsigned char)(n >> 16); p[3] = (unsigned char)(n >> 24);
}
static int synthetic(void) {
  /* Synthetic SID S-1-5-21, not a second OS account or an actual owner identity. */
  const unsigned char sid[12] = { 1, 1, 0, 0, 0, 0, 0, 5, 21, 0, 0, 0 };
  unsigned char good[60] = { 0 }, changed[60], other[12]; size_t n;
  good[0] = 1; put16(good + 2, SE_SELF_RELATIVE | SE_DACL_PRESENT | SE_DACL_PROTECTED);
  put32(good + 4, 20); put32(good + 16, 32); memcpy(good + 20, sid, 12);
  good[32] = ACL_REVISION; put16(good + 34, 28); put16(good + 36, 1);
  put16(good + 42, 20); put32(good + 44, WD_SELF_RIGHTS); memcpy(good + 48, sid, 12);
  if (!wd_test_descriptor(good, sizeof(good), sid, sizeof(sid))) return 0;
  for (n = 0; n < sizeof(good); n++) if (wd_test_descriptor(good, n, sid, sizeof(sid))) return 0;
  if (wd_test_descriptor(good, WD_DESCRIPTOR_LIMIT + 1u, sid, sizeof(sid))) return 0;
  memcpy(other, sid, sizeof(other)); other[8]++;
  if (wd_test_descriptor(good, sizeof(good), other, sizeof(other))) return 0;
  /* Closed corruptions: owner offset, SID count, ACL/ACE length, ACE type,
   * inherited flag, rights, duplicate ACE and null DACL. */
  for (n = 0; n < 9; n++) {
    memcpy(changed, good, sizeof(good));
    switch (n) {
      case 0: put32(changed + 4, UINT32_MAX); break;
      case 1: changed[21] = 255; break;
      case 2: put16(changed + 34, 65535); break;
      case 3: put16(changed + 42, 65535); break;
      case 4: changed[40] = ACCESS_ALLOWED_CALLBACK_ACE_TYPE; break;
      case 5: changed[41] = INHERITED_ACE; break;
      case 6: put32(changed + 44, GENERIC_ALL); break;
      case 7: put16(changed + 36, 2); break;
      default: put32(changed + 16, 0); break;
    }
    if (wd_test_descriptor(changed, sizeof(changed), sid, sizeof(sid))) return 0;
  }
  /* Deterministic generated invalid absolute offsets never reach SID parsing. */
  for (n = 0; n < 512; n++) {
    memcpy(changed, good, sizeof(good)); put32(changed + 16, (uint32_t)(sizeof(good) + n));
    if (wd_test_descriptor(changed, sizeof(changed), sid, sizeof(sid))) return 0;
  }
  return 1;
}
static int junction(HANDLE h, const WCHAR *target) {
  struct mount_point {
    DWORD tag; WORD data_length; WORD reserved;
    WORD substitute_offset, substitute_length, print_offset, print_length;
    WCHAR path[512];
  } value;
  int chars; DWORD returned;
  ZeroMemory(&value, sizeof(value));
  chars = swprintf_s(value.path, 512, L"\\??\\%s", target);
  if (chars <= 0 || chars >= 500) return 0;
  value.tag = IO_REPARSE_TAG_MOUNT_POINT;
  value.substitute_length = (WORD)(chars * (int)sizeof(WCHAR));
  value.print_offset = value.substitute_length + (WORD)sizeof(WCHAR);
  value.data_length = (WORD)(8 + value.print_offset + sizeof(WCHAR));
  return DeviceIoControl(h, FSCTL_SET_REPARSE_POINT, &value,
    (DWORD)(8 + value.data_length), NULL, 0, &returned, NULL) != 0;
}

int wmain(int argc, wchar_t **argv) {
  WCHAR temp[MAX_PATH], root[MAX_PATH] = { 0 }, a[MAX_PATH], b[MAX_PATH], moved[MAX_PATH];
  WCHAR ordinary[MAX_PATH], link[MAX_PATH], target[MAX_PATH], guid[40], gate[4];
  GUID nonce; HANDLE token = NULL, h = INVALID_HANDLE_VALUE, peer = INVALID_HANDLE_VALUE;
  wd_binding *binding = NULL, *second = NULL;
  union { TOKEN_USER alignment; unsigned char bytes[512]; } user_buffer;
  unsigned char everyone[SECURITY_MAX_SID_SIZE]; DWORD user_bytes, everyone_bytes = sizeof(everyone), chars;
  PSID user = NULL; unsigned int cases = 0; int passed = 0, cleanup_ok = 1;
  int made_root = 0, made_a = 0, made_b = 0, made_file = 0, made_link = 0, made_target = 0;
  (void)argv;
  REQUIRE(argc == 1 && sizeof(void *) == 8);
  REQUIRE(GetEnvironmentVariableW(L"OOMPA_WINDOWS_DIRECTORY_NATIVE", gate, 4) == 1 && gate[0] == L'1');
  REQUIRE(synthetic()); CASE();
  REQUIRE(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)); opened_handles++;
  REQUIRE(GetTokenInformation(token, TokenUser, user_buffer.bytes, sizeof(user_buffer.bytes), &user_bytes));
  user = ((TOKEN_USER *)user_buffer.bytes)->User.Sid;
  REQUIRE(IsValidSid(user) && GetLengthSid(user) <= SECURITY_MAX_SID_SIZE);
  REQUIRE(close_owned(&token));
  REQUIRE(CreateWellKnownSid(WinWorldSid, NULL, everyone, &everyone_bytes));
  chars = GetEnvironmentVariableW(L"RUNNER_TEMP", temp, MAX_PATH);
  REQUIRE(chars > 3 && chars < 180 && temp[1] == L':' && temp[2] == L'\\');
  REQUIRE(CoCreateGuid(&nonce) == S_OK && StringFromGUID2(&nonce, guid, 40) == 39);
  REQUIRE(swprintf_s(root, MAX_PATH, L"%s\\oompa-directory-security-%s", temp, guid) > 0);
  REQUIRE(create_private(root, user)); made_root = 1;
  REQUIRE(make_path(a, root, L"a") && make_path(b, root, L"b") && make_path(moved, root, L"moved")
    && make_path(ordinary, root, L"ordinary") && make_path(link, root, L"junction") && make_path(target, root, L"target"));
  REQUIRE(create_private(a, user)); made_a = 1;
  REQUIRE(create_private(b, user)); made_b = 1;
  REQUIRE(create_private(target, user)); made_target = 1;
  REQUIRE(wd_adopt(&h, &binding) == WD_REFUSED && binding == NULL); CASE();
  h = open_directory(a); REQUIRE(h != INVALID_HANDLE_VALUE);
  REQUIRE(wd_adopt(&h, &binding) == WD_OK && h == INVALID_HANDLE_VALUE);
  REQUIRE(wd_revalidate(binding) == WD_OK); CASE();
  h = open_directory(b); REQUIRE(h != INVALID_HANDLE_VALUE);
  REQUIRE(wd_adopt(&h, &second) == WD_OK);
  REQUIRE(wd_same_directory(binding, second) == WD_REFUSED); CASE();
  REQUIRE(close_binding(&second));
  REQUIRE(!MoveFileW(a, moved) && delete_refused()); CASE();
  REQUIRE(!RemoveDirectoryW(a) && delete_refused()); CASE();
  REQUIRE(close_binding(&binding));
  REQUIRE(MoveFileW(a, moved)); made_a = 0;
  REQUIRE(MoveFileW(moved, a)); made_a = 1; CASE();
  REQUIRE(RemoveDirectoryW(a)); made_a = 0; CASE();
  REQUIRE(create_private(a, user)); made_a = 1;
  h = open_directory(a); REQUIRE(h != INVALID_HANDLE_VALUE);
  REQUIRE(wd_adopt(&h, &binding) == WD_OK);
  peer = open_peer_directory(a); REQUIRE(peer != INVALID_HANDLE_VALUE);
  REQUIRE(set_acl(peer, everyone, 0, 1, 0));
  REQUIRE(wd_revalidate(binding) == WD_REFUSED); CASE();
  REQUIRE(set_acl(peer, user, 0, 1, 0));
  REQUIRE(wd_revalidate(binding) == WD_REFUSED); CASE(); /* sticky refusal */
  REQUIRE(close_binding(&binding) && close_owned(&peer));
  /* Reuse only the exact fresh synthetic directory, opening a new handle for
   * every distinct ACL condition. The core never repairs a refused binding. */
  for (unsigned int scenario = 0; scenario < 4; scenario++) {
    h = open_directory(a); REQUIRE(h != INVALID_HANDLE_VALUE);
    REQUIRE(set_acl(h, scenario == 0 ? everyone : user, scenario == 1 ? INHERITED_ACE : 0,
      scenario != 2, scenario == 3));
    REQUIRE(wd_adopt(&h, &binding) == WD_REFUSED && binding == NULL); CASE();
    REQUIRE(set_acl(h, user, 0, 1, 0) && close_owned(&h));
  }
  h = open_directory(a); REQUIRE(h != INVALID_HANDLE_VALUE);
  REQUIRE(SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT));
  REQUIRE(wd_adopt(&h, &binding) == WD_REFUSED && binding == NULL); CASE();
  REQUIRE(SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0) && close_owned(&h));
  h = CreateFileW(ordinary, GENERIC_READ | GENERIC_WRITE | READ_CONTROL, 0, NULL,
    CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  REQUIRE(h != INVALID_HANDLE_VALUE); opened_handles++; made_file = 1;
  REQUIRE(wd_adopt(&h, &binding) == WD_REFUSED); CASE(); REQUIRE(close_owned(&h));
  REQUIRE(create_private(link, user)); made_link = 1;
  h = CreateFileW(link, GENERIC_WRITE | READ_CONTROL, 0, NULL, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  REQUIRE(h != INVALID_HANDLE_VALUE); opened_handles++;
  REQUIRE(junction(h, target) && close_owned(&h));
  h = open_directory(link); REQUIRE(h != INVALID_HANDLE_VALUE);
  REQUIRE(wd_adopt(&h, &binding) == WD_REFUSED); CASE(); REQUIRE(close_owned(&h));
  h = open_directory(a); REQUIRE(h != INVALID_HANDLE_VALUE);
  REQUIRE(ImpersonateSelf(SecurityImpersonation));
  { wd_status observed = wd_adopt(&h, &binding); BOOL reverted = RevertToSelf();
    REQUIRE(reverted && observed == WD_REFUSED); }
  CASE(); REQUIRE(close_owned(&h));
  REQUIRE(cases == 18);
  passed = 1;
cleanup:
  /* Exact tracked objects only; do not recursively traverse a junction/root. */
  if (!close_binding(&binding)) cleanup_ok = 0;
  if (!close_binding(&second)) cleanup_ok = 0;
  if (!close_owned(&h)) cleanup_ok = 0;
  if (!close_owned(&peer)) cleanup_ok = 0;
  if (!close_owned(&token)) cleanup_ok = 0;
  if (opened_handles != closed_handles || wd_test_opened_tokens() != wd_test_closed_tokens()) cleanup_ok = 0;
  if (cleanup_ok && made_link && !RemoveDirectoryW(link)) cleanup_ok = 0;
  if (cleanup_ok && made_file && !DeleteFileW(ordinary)) cleanup_ok = 0;
  if (cleanup_ok && made_a && !RemoveDirectoryW(a)) cleanup_ok = 0;
  if (cleanup_ok && made_b && !RemoveDirectoryW(b)) cleanup_ok = 0;
  if (cleanup_ok && made_target && !RemoveDirectoryW(target)) cleanup_ok = 0;
  if (cleanup_ok && made_root && !RemoveDirectoryW(root)) cleanup_ok = 0;
  SecureZeroMemory(&user_buffer, sizeof(user_buffer));
  printf("{\"schema\":1,\"source\":\"credential_free_win32_fixture\",\"cases\":%u,\"passed\":%s,\"cleanup\":\"%s\",\"handlesOpened\":%lu,\"handlesClosed\":%lu,\"tokensOpened\":%lu,\"tokensClosed\":%lu,\"failureLine\":%d}\n",
    cases, passed && cleanup_ok ? "true" : "false", cleanup_ok ? "joined" : "uncertain",
    opened_handles, closed_handles, wd_test_opened_tokens(), wd_test_closed_tokens(), failed_line);
  return passed && cleanup_ok ? 0 : 70;
}
