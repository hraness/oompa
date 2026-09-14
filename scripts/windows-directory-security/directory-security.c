#include "directory-security.h"
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#ifndef WD_DESCRIPTOR_LIMIT
#define WD_DESCRIPTOR_LIMIT 16384u
#define WD_SELF_RIGHTS FILE_ALL_ACCESS
#endif
#define WD_SID_LIMIT 68u

struct wd_binding {
  HANDLE handle;
  FILE_ID_INFO identity;
  unsigned char user[WD_SID_LIMIT];
  size_t user_length;
  int poisoned;
  int close_attempted;
};
static unsigned long opened_tokens;
static unsigned long closed_tokens;

static uint16_t u16(const unsigned char *p) {
  return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}
static uint32_t u32(const unsigned char *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8)
    | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static int span(size_t offset, size_t length, size_t bound) {
  return offset <= bound && length <= bound - offset;
}
static size_t sid_length(const unsigned char *p, size_t available) {
  size_t length;
  if (p == NULL || available < 8 || p[0] != SID_REVISION || p[1] > 15) return 0;
  length = 8u + 4u * (size_t)p[1];
  return length <= available && length <= WD_SID_LIMIT ? length : 0;
}
static int disjoint(size_t a, size_t an, size_t b, size_t bn) {
  return a + an <= b || b + bn <= a;
}

/* Parse relative offsets before inspecting any SID or ACE. This deliberately
 * admits one policy, not the full Windows access-check language. */
static int descriptor(const unsigned char *p, size_t n,
    const unsigned char *user, size_t un) {
  size_t owner, group, acl, on, gn = 0, acln, ace, acen, sn;
  uint16_t control;
  if (p == NULL || n < 20 || n > WD_DESCRIPTOR_LIMIT
      || un == 0 || sid_length(user, un) != un || p[0] != 1 || p[1] != 0) return 0;
  control = u16(p + 2);
  if ((control & (SE_SELF_RELATIVE | SE_DACL_PRESENT | SE_DACL_PROTECTED))
      != (SE_SELF_RELATIVE | SE_DACL_PRESENT | SE_DACL_PROTECTED)
      || (control & ~(SE_SELF_RELATIVE | SE_DACL_PRESENT | SE_DACL_PROTECTED | SE_GROUP_DEFAULTED)) != 0
      || u32(p + 12) != 0) return 0;
  owner = u32(p + 4); group = u32(p + 8); acl = u32(p + 16);
  if (owner < 20 || acl < 20 || (owner & 3) != 0 || (acl & 3) != 0
      || !span(owner, 8, n) || !span(acl, 8, n)) return 0;
  on = sid_length(p + owner, n - owner);
  if (on != un || memcmp(p + owner, user, un) != 0) return 0;
  acln = u16(p + acl + 2);
  if (p[acl] != ACL_REVISION || p[acl + 1] != 0 || u16(p + acl + 6) != 0
      || u16(p + acl + 4) != 1 || acln < 16 || !span(acl, acln, n)
      || !disjoint(owner, on, acl, acln)) return 0;
  if (group != 0) {
    if (group < 20 || (group & 3) != 0 || !span(group, 8, n)) return 0;
    gn = sid_length(p + group, n - group);
    if (gn == 0 || !disjoint(group, gn, owner, on) || !disjoint(group, gn, acl, acln)) return 0;
  }
  ace = acl + 8;
  acen = u16(p + ace + 2);
  if (p[ace] != ACCESS_ALLOWED_ACE_TYPE || p[ace + 1] != 0 || acen < 16
      || acen != acln - 8 || u32(p + ace + 4) != WD_SELF_RIGHTS) return 0;
  sn = sid_length(p + ace + 8, acen - 8);
  return sn == un && acen == 8 + sn && memcmp(p + ace + 8, user, un) == 0;
}

static wd_status close_token(HANDLE token) {
  if (!CloseHandle(token)) return WD_CLEANUP_UNCERTAIN;
  closed_tokens++;
  return WD_OK;
}
static wd_status current_user(unsigned char user[WD_SID_LIMIT], size_t *length) {
  HANDLE token = NULL;
  DWORD bytes = 0;
  union { TOKEN_USER alignment; unsigned char data[512]; } buffer;
  uintptr_t offset;
  size_t n;
  wd_status result = WD_REFUSED;
  if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &token)) {
    opened_tokens++;
    return close_token(token) == WD_OK ? WD_REFUSED : WD_CLEANUP_UNCERTAIN;
  }
  if (GetLastError() != ERROR_NO_TOKEN || !OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return WD_REFUSED;
  opened_tokens++;
  ZeroMemory(&buffer, sizeof(buffer));
  if (GetTokenInformation(token, TokenUser, buffer.data, sizeof(buffer.data), &bytes)
      && bytes <= sizeof(buffer.data) && bytes >= sizeof(TOKEN_USER)) {
    PSID sid = ((TOKEN_USER *)buffer.data)->User.Sid;
    if ((uintptr_t)sid >= (uintptr_t)buffer.data) {
      offset = (uintptr_t)sid - (uintptr_t)buffer.data;
      if (offset <= bytes) {
        n = sid_length((const unsigned char *)sid, bytes - offset);
        if (n != 0) { memcpy(user, sid, n); *length = n; result = WD_OK; }
      }
    }
  }
  SecureZeroMemory(&buffer, sizeof(buffer));
  if (close_token(token) != WD_OK) result = WD_CLEANUP_UNCERTAIN;
  return result;
}

static int metadata(HANDLE handle, FILE_ID_INFO *identity) {
  FILE_ATTRIBUTE_TAG_INFO tags;
  FILE_STANDARD_INFO standard;
  DWORD flags, volume_flags, chars;
  WCHAR filesystem[16], path[1024];
  if (handle == NULL || handle == INVALID_HANDLE_VALUE || GetFileType(handle) != FILE_TYPE_DISK
      || !GetHandleInformation(handle, &flags) || (flags & HANDLE_FLAG_INHERIT) != 0
      || !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tags, sizeof(tags))
      || (tags.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0
      || (tags.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || tags.ReparseTag != 0
      || !GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard))
      || !standard.Directory || standard.DeletePending
      || !GetFileInformationByHandleEx(handle, FileIdInfo, identity, sizeof(*identity))
      || !GetVolumeInformationByHandleW(handle, NULL, 0, NULL, NULL, &volume_flags, filesystem, 16)
      || wcscmp(filesystem, L"NTFS") != 0 || (volume_flags & FILE_PERSISTENT_ACLS) == 0) return 0;
  chars = GetFinalPathNameByHandleW(handle, path, 1024, FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
  /* SMB does not provide a local volume GUID. No pathname authority is returned. */
  return chars > 0 && chars < 1024 && wcsncmp(path, L"\\\\?\\Volume{", 11) == 0;
}
static int same_id(const FILE_ID_INFO *a, const FILE_ID_INFO *b) {
  return a->VolumeSerialNumber == b->VolumeSerialNumber
    && memcmp(a->FileId.Identifier, b->FileId.Identifier, 16) == 0;
}
static wd_status observe(HANDLE handle, FILE_ID_INFO *identity,
    unsigned char user[WD_SID_LIMIT], size_t *user_length) {
  FILE_ID_INFO before, after = { 0 };
  unsigned char descriptor_bytes[WD_DESCRIPTOR_LIMIT], second[WD_SID_LIMIT];
  size_t second_length = 0;
  DWORD needed = 0;
  wd_status result = current_user(user, user_length);
  if (result != WD_OK) return result;
  if (!metadata(handle, &before)) return WD_REFUSED;
  ZeroMemory(descriptor_bytes, sizeof(descriptor_bytes));
  if (!GetKernelObjectSecurity(handle, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        (PSECURITY_DESCRIPTOR)descriptor_bytes, sizeof(descriptor_bytes), &needed)
      || !descriptor(descriptor_bytes, needed, user, *user_length)
      || !metadata(handle, &after) || !same_id(&before, &after)) result = WD_REFUSED;
  else {
    result = current_user(second, &second_length);
    if (result == WD_OK && (second_length != *user_length || memcmp(second, user, second_length) != 0)) result = WD_REFUSED;
  }
  SecureZeroMemory(descriptor_bytes, sizeof(descriptor_bytes));
  SecureZeroMemory(second, sizeof(second));
  if (result == WD_OK) *identity = after;
  return result;
}

wd_status wd_adopt(HANDLE *owned, wd_binding **result) {
  wd_binding *binding;
  wd_status status;
  if (owned == NULL || result == NULL || *result != NULL) return WD_REFUSED;
  binding = (wd_binding *)calloc(1, sizeof(*binding));
  if (binding == NULL) return WD_REFUSED;
  status = observe(*owned, &binding->identity, binding->user, &binding->user_length);
  if (status != WD_OK) { SecureZeroMemory(binding, sizeof(*binding)); free(binding); return status; }
  binding->handle = *owned;
  *owned = INVALID_HANDLE_VALUE;
  *result = binding;
  return WD_OK;
}
wd_status wd_revalidate(wd_binding *binding) {
  FILE_ID_INFO identity;
  unsigned char user[WD_SID_LIMIT];
  size_t length = 0;
  wd_status status;
  if (binding == NULL || binding->poisoned || binding->close_attempted) return WD_REFUSED;
  status = observe(binding->handle, &identity, user, &length);
  if (status == WD_OK && (!same_id(&identity, &binding->identity)
      || length != binding->user_length || memcmp(user, binding->user, length) != 0)) status = WD_REFUSED;
  SecureZeroMemory(user, sizeof(user));
  if (status != WD_OK) binding->poisoned = 1;
  return status;
}
wd_status wd_same_directory(wd_binding *first, wd_binding *second) {
  wd_status a = wd_revalidate(first), b = wd_revalidate(second);
  if (a == WD_CLEANUP_UNCERTAIN || b == WD_CLEANUP_UNCERTAIN) return WD_CLEANUP_UNCERTAIN;
  return a == WD_OK && b == WD_OK && same_id(&first->identity, &second->identity) ? WD_OK : WD_REFUSED;
}
wd_status wd_close(wd_binding **value) {
  wd_binding *binding;
  if (value == NULL || *value == NULL || (*value)->close_attempted) return WD_REFUSED;
  binding = *value;
  binding->close_attempted = 1;
  binding->poisoned = 1;
  if (!CloseHandle(binding->handle)) return WD_CLEANUP_UNCERTAIN;
  SecureZeroMemory(binding, sizeof(*binding)); free(binding); *value = NULL;
  return WD_OK;
}
#ifdef WD_TESTING
int wd_test_descriptor(const unsigned char *p, size_t n, const unsigned char *u, size_t un) {
  return descriptor(p, n, u, un);
}
unsigned long wd_test_opened_tokens(void) { return opened_tokens; }
unsigned long wd_test_closed_tokens(void) { return closed_tokens; }
#endif
