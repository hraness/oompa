#ifndef OOMPA_WINDOWS_DIRECTORY_SECURITY_H
#define OOMPA_WINDOWS_DIRECTORY_SECURITY_H

#define WIN32_LEAN_AND_MEAN
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <stddef.h>

/* Scripts-only experiment. No pathname, SID, descriptor or native handle output. */
typedef struct wd_binding wd_binding;
typedef enum wd_status {
  WD_OK = 0, WD_REFUSED = 1, WD_CLEANUP_UNCERTAIN = 2
} wd_status;

/* On success consumes *owned and sets it INVALID_HANDLE_VALUE. On refusal the
 * caller still owns it. No duplicated handle or privilege adjustment occurs. */
wd_status wd_adopt(HANDLE *owned, wd_binding **result);
wd_status wd_revalidate(wd_binding *binding);
wd_status wd_same_directory(wd_binding *first, wd_binding *second);
/* One attempt only. A failed close retains the poisoned binding for diagnosis. */
wd_status wd_close(wd_binding **binding);

#ifdef WD_TESTING
#define WD_DESCRIPTOR_LIMIT 16384u
#define WD_SELF_RIGHTS FILE_ALL_ACCESS
/* Synthetic byte-parser tests only; cannot create a native binding. */
int wd_test_descriptor(const unsigned char *bytes, size_t length,
  const unsigned char *user, size_t user_length);
unsigned long wd_test_opened_tokens(void);
unsigned long wd_test_closed_tokens(void);
#endif
#endif
