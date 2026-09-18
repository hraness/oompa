import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";
import { getDesignPaletteTheme } from "@hraness/design-kit";
import fc from "fast-check";

import { appDevelopmentConfig, appProductionConfig } from "../app/vite.config.ts";
import {
  acquireAppPublicationLock, APP_CSS_PLACEHOLDER, APP_PROCESS_CUSTODY_FILE, AppProcessCustodyError,
  appPublicationRecord, appSha256, assertAppRunDirectory, beginAppProcessCustody,
  commitAppPublication, createAppSourceMarkerEvidence, parseAppComplete, parseAppPublication, prepareAppShell,
  readAppInventory, reconcileAppPublication, revalidateAppSourceMarker, revalidateAppSourceMarkerInputs,
  snapshotAppGraph, snapshotAppSourceEnvironment,
  type AppArtifact, type AppPublicationFailureBoundary, type AppPublicationLock,
  type AppSourceMarkerEvidence,
} from "./build-app.ts";
import { APP_SOURCE_MARKER_PATH } from "./app-source-marker.ts";

const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { force: true, recursive: true });
  }));
});

const entry = "/fixture/app/src/main.tsx";
const faviconBytes = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 606 575\" width=\"606\" height=\"575\">\n  <path d=\"M0 0 C4.4892 0.7969 7.9155 2.3072 11.9866 4.4006 C13.4245 5.1338 14.8627 5.8665 16.3011 6.5989 C17.446 7.1854 17.446 7.1854 18.6141 7.7836 C22.7493 9.8918 26.9071 11.9546 31.0623 14.0232 C32.8779 14.9292 34.6935 15.8353 36.509 16.7417 C37.4395 17.2061 38.37 17.6706 39.3287 18.1491 C45.375 21.1674 51.4205 24.1872 57.4659 27.2071 C62.7605 29.8517 68.0555 32.4956 73.3513 35.1379 C78.5123 37.713 83.6724 40.2901 88.8318 42.8684 C90.7927 43.848 92.754 44.8268 94.7157 45.805 C97.4376 47.1623 100.1583 48.5221 102.8787 49.8826 C103.6915 50.2872 104.5043 50.6918 105.3418 51.1087 C110.8859 53.8859 110.8859 53.8859 112 55 C112.1053 56.8637 112.1397 58.7314 112.1472 60.5981 C112.1579 62.4216 112.1579 62.4216 112.1689 64.2819 C112.1715 65.6279 112.1742 66.9738 112.177 68.3606 C112.1836 69.7686 112.1901 71.1766 112.1969 72.6272 C112.2133 76.5013 112.2249 80.3753 112.2331 84.2494 C112.2383 86.6681 112.2443 89.0868 112.2506 91.5055 C112.2697 99.0682 112.2839 106.6308 112.2922 114.1935 C112.302 122.9324 112.3283 131.6711 112.3687 140.4099 C112.3989 147.1581 112.4137 153.9062 112.417 160.6545 C112.4194 164.6879 112.4284 168.721 112.4535 172.7542 C112.481 177.2534 112.4769 181.752 112.47 186.2512 C112.4892 188.2611 112.4892 188.2611 112.5088 190.3115 C112.4984 192.1477 112.4984 192.1477 112.4877 194.021 C112.4901 195.0852 112.4925 196.1495 112.495 197.2461 C111.8759 200.6906 110.6791 201.8248 108 204 C105.8534 205.3071 105.8534 205.3071 103.5137 206.4543 C102.6318 206.8919 101.7498 207.3295 100.8412 207.7803 C99.8933 208.2408 98.9454 208.7013 97.9688 209.1758 C96.9819 209.664 95.995 210.1523 94.9781 210.6553 C91.8225 212.2154 88.6617 213.7647 85.5 215.3125 C81.3619 217.3448 77.2264 219.3823 73.0938 221.4258 C72.0928 221.9203 71.0918 222.4148 70.0605 222.9243 C65.2588 225.3139 60.5545 227.7541 55.9688 230.543 C49.7564 234.2916 43.2272 237.304 36.6739 240.3996 C24.606 246.1073 12.6685 252.0727 0.7288 258.043 C-3.191 260.0018 -7.114 261.9541 -11.0371 263.9062 C-13.6018 265.1871 -16.1662 266.4683 -18.7305 267.75 C-19.8675 268.3149 -21.0046 268.8799 -22.1761 269.4619 C-32.628 274.7022 -42.7275 280.3501 -53 286 C-53.33 312.07 -53.66 338.14 -54 365 C-60.6 368.3 -67.2 371.6 -74 375 C-80.0103 378.1635 -80.0103 378.1635 -86.0159 381.3359 C-96.5121 386.8899 -107.1754 392.1162 -117.8115 397.3955 C-120.6044 398.7827 -123.3963 400.1719 -126.1875 401.5625 C-127.5426 402.2371 -127.5426 402.2371 -128.925 402.9253 C-135.9585 406.4423 -142.9223 410.0826 -149.8367 413.8284 C-153.8124 415.958 -157.6675 417.7318 -162 419 C-163.9996 417.0004 -163.1574 412.8841 -163.1741 410.2827 C-163.1806 409.4645 -163.1871 408.6464 -163.1938 407.8035 C-163.2143 405.0406 -163.2274 402.2776 -163.2405 399.5146 C-163.2533 397.5423 -163.2664 395.57 -163.2799 393.5977 C-163.3958 375.5839 -163.4524 357.5696 -163.4966 339.5555 C-163.5299 326.2306 -163.5895 312.9065 -163.6841 299.5819 C-163.7484 290.2231 -163.7822 280.8644 -163.7934 271.5054 C-163.801 265.9107 -163.8223 260.3169 -163.8764 254.7225 C-163.9267 249.4593 -163.9395 244.1973 -163.9232 238.9339 C-163.9238 237.0009 -163.9381 235.0678 -163.9671 233.135 C-164.0046 230.4969 -163.9929 227.8634 -163.9688 225.2253 C-163.9779 223.0108 -163.9779 223.0108 -163.9872 220.7515 C-162.9055 216.6407 -162.5475 216.2545 -159.161 214.1033 C-157.7886 213.374 -156.4016 212.6715 -155 212 C-153.8304 211.3804 -152.6608 210.7607 -151.4558 210.1223 C-149.6891 209.2516 -149.6891 209.2516 -147.8867 208.3633 C-147.2328 208.0389 -146.5789 207.7146 -145.9052 207.3804 C-143.8346 206.3539 -141.7613 205.3327 -139.6875 204.3125 C-130.2115 199.6364 -120.7988 194.8707 -111.4592 189.9272 C-102.5874 185.238 -93.6481 180.6832 -84.7059 176.1302 C-79.5759 173.5179 -74.4483 170.9011 -69.3203 168.2852 C-68.2866 167.758 -67.253 167.2308 -66.188 166.6877 C-56.8157 161.9075 -47.4474 157.1198 -38.0841 152.3222 C-36.4781 151.4995 -34.8719 150.6773 -33.2655 149.8555 C-29.605 147.9829 -25.9478 146.1046 -22.2979 144.2114 C-19.2697 142.6428 -16.2226 141.1193 -13.1631 139.6128 C-11.5956 138.8242 -10.0282 138.0353 -8.4609 137.2461 C-7.7263 136.8936 -6.9917 136.5411 -6.2348 136.178 C-3.9427 135.0592 -3.9427 135.0592 -1 133 C0.0512 129.5193 0.1238 126.1572 0.1203 122.5394 C0.1216 121.4555 0.123 120.3716 0.1244 119.2549 C0.1208 118.0759 0.1172 116.897 0.1135 115.6824 C0.1137 113.8086 0.1137 113.8086 0.114 111.897 C0.1133 107.7685 0.1055 103.6401 0.0977 99.5117 C0.0958 96.6491 0.0944 93.7864 0.0934 90.9238 C0.0899 84.1595 0.0821 77.3952 0.072 70.6309 C0.0608 62.9284 0.0553 55.2259 0.0503 47.5234 C0.0399 31.6823 0.0223 15.8411 0 0 Z \" transform=\"translate(329,112)\" fill=\"#2474d4\"/>\n  <path d=\"M0 0 C0 120.78 0 241.56 0 366 C-16 374 -16 374 -21.2695 376.6172 C-22.0346 376.9975 -22.7996 377.3777 -23.5879 377.7695 C-25.0585 378.5003 -26.5298 379.2295 -28.002 379.957 C-32.7419 382.3171 -37.4364 384.7536 -42.1147 387.2338 C-54.1681 393.6205 -66.3396 399.7629 -78.5403 405.8628 C-82.1182 407.6529 -85.6929 409.4494 -89.2676 411.2461 C-91.5441 412.3858 -93.8208 413.5251 -96.0977 414.6641 C-97.1652 415.2014 -98.2327 415.7388 -99.3325 416.2924 C-100.3121 416.7807 -101.2917 417.2689 -102.301 417.772 C-103.5941 418.4196 -103.5941 418.4196 -104.9132 419.0802 C-107 420 -107 420 -109 420 C-109.183 373.459 -109.324 326.9179 -109.4085 280.3766 C-109.4185 274.8853 -109.4289 269.3939 -109.4395 263.9026 C-109.4416 262.8093 -109.4437 261.7161 -109.4458 260.5897 C-109.4806 242.8747 -109.5437 225.1599 -109.6172 207.445 C-109.692 189.2755 -109.7365 171.1061 -109.7527 152.9365 C-109.7637 141.7196 -109.7984 130.5033 -109.8633 119.2867 C-109.9055 111.6008 -109.9184 103.9153 -109.908 96.2294 C-109.9029 91.791 -109.9109 87.3536 -109.9536 82.9154 C-109.9925 78.8542 -109.9946 74.7946 -109.9672 70.7333 C-109.9622 68.5637 -109.9968 66.3941 -110.0327 64.2248 C-109.9186 55.0212 -109.9186 55.0212 -107.2438 52.0476 C-105.0983 50.6769 -105.0983 50.6769 -101 49 C-100.1636 48.5621 -99.3273 48.1242 -98.4656 47.6731 C-97.7486 47.344 -97.0317 47.0149 -96.293 46.6758 C-95.4695 46.2924 -94.646 45.9091 -93.7976 45.5142 C-92.9363 45.1176 -92.0749 44.7211 -91.1875 44.3125 C-84.2648 41.0718 -77.4306 37.7246 -70.6875 34.125 C-54.6239 25.5663 -38.2887 17.5532 -21.8479 9.7471 C-15.852 6.8988 -9.9057 3.9803 -4.0117 0.9258 C-2 0 -2 0 0 0 Z \" transform=\"translate(564,113)\" fill=\"#2474d4\"/>\n  <path d=\"M0 0 C7.6847 3.2821 7.6847 3.2821 11.1208 4.9578 C11.8495 5.3121 12.5781 5.6665 13.3288 6.0315 C14.479 6.5941 14.479 6.5941 15.6523 7.168 C16.4701 7.5665 17.2879 7.965 18.1305 8.3756 C19.858 9.2178 21.5851 10.0608 23.3118 10.9045 C25.8977 12.168 28.4849 13.429 31.0723 14.6895 C39.9978 19.0416 48.9018 23.4328 57.7776 27.8855 C61.7918 29.8986 65.8136 31.8964 69.8362 33.8928 C73.536 35.7295 77.2339 37.5701 80.9316 39.4109 C82.8313 40.3556 84.7317 41.299 86.6328 42.241 C89.4185 43.6217 92.2017 45.0076 94.9844 46.3945 C95.8322 46.8133 96.6801 47.2321 97.5536 47.6635 C98.3426 48.0579 99.1315 48.4523 99.9443 48.8586 C100.6333 49.2009 101.3223 49.5432 102.0322 49.8958 C104.2938 51.1648 106.1066 52.2033 108 54 C108.4968 56.713 108.4968 56.713 108.4922 60.0695 C108.5002 61.3469 108.5081 62.6243 108.5163 63.9404 C108.4988 66.0576 108.4988 66.0576 108.481 68.2176 C108.4828 69.7257 108.4863 71.2339 108.4914 72.742 C108.5003 76.8969 108.4843 81.0515 108.4643 85.2064 C108.447 89.6829 108.4528 94.1593 108.4559 98.6358 C108.458 106.3952 108.4454 114.1544 108.4229 121.9137 C108.3905 133.1324 108.38 144.3511 108.375 155.5699 C108.3662 173.7703 108.3396 191.9707 108.3018 210.1711 C108.2651 227.8541 108.2367 245.537 108.2197 263.22 C108.2182 264.8542 108.2182 264.8542 108.2165 266.5214 C108.2113 271.9868 108.2063 277.4521 108.2013 282.9175 C108.1598 328.2784 108.0893 373.6392 108 419 C104.092 418.283 101.03 417.1955 97.4731 415.3989 C96.3866 414.8539 95.3 414.3089 94.1805 413.7473 C93.0097 413.1527 91.839 412.558 90.6328 411.9453 C89.4071 411.3291 88.1813 410.7129 86.9184 410.0781 C82.9844 408.0994 79.0545 406.1126 75.125 404.125 C70.0042 401.5411 64.8816 398.9608 59.7578 396.3828 C58.5034 395.7511 57.249 395.1195 55.9565 394.4687 C47.1889 390.0659 38.3687 385.7878 29.5057 381.581 C22.9992 378.4904 16.5543 375.3082 10.1875 371.9375 C9.3064 371.4792 8.4254 371.021 7.5176 370.5488 C1.2572 367.2572 1.2572 367.2572 -1 365 C-1.1964 361.6591 -1.2646 358.4011 -1.2472 355.0591 C-1.2497 354.0123 -1.2521 352.9655 -1.2546 351.887 C-1.2602 348.3513 -1.2515 344.8157 -1.2429 341.28 C-1.244 338.7509 -1.2459 336.2217 -1.2487 333.6925 C-1.2535 326.7734 -1.2458 319.8543 -1.2357 312.9351 C-1.2269 305.6088 -1.2287 298.2826 -1.2291 290.9563 C-1.2285 278.5531 -1.2195 266.15 -1.2058 253.7468 C-1.192 241.2035 -1.1847 228.6602 -1.1853 216.1169 C-1.1881 144.0731 -1.0259 72.0377 0 0 Z \" transform=\"translate(43,113)\" fill=\"#2474d4\"/>\n  <path d=\"M0 0 C0 66.33 0 132.66 0 201 C-0.66 201.33 -1.32 201.66 -2 202 C-4.7084 200.7821 -7.2974 199.4973 -9.918 198.1094 C-10.7262 197.6901 -11.5345 197.2709 -12.3673 196.8389 C-14.978 195.4834 -17.583 194.1175 -20.1875 192.75 C-31.7565 186.6998 -43.371 180.8084 -55.1676 175.213 C-65.2667 170.4173 -75.2793 165.4534 -85.2786 160.4534 C-88.3821 158.9027 -91.4889 157.3586 -94.5957 155.8145 C-96.5809 154.8233 -98.566 153.8318 -100.5508 152.8398 C-101.4745 152.3816 -102.3982 151.9233 -103.3499 151.4512 C-104.1965 151.0263 -105.0431 150.6015 -105.9153 150.1638 C-106.6587 149.7928 -107.402 149.4219 -108.1679 149.0397 C-110 148 -110 148 -112 146 C-112.2302 143.1662 -112.3355 140.4279 -112.354 137.5906 C-112.3671 136.7205 -112.3803 135.8504 -112.3938 134.954 C-112.4333 132.067 -112.4566 129.1802 -112.4766 126.293 C-112.4847 125.3081 -112.4929 124.3233 -112.5013 123.3086 C-112.543 118.0963 -112.5716 112.8841 -112.5903 107.6716 C-112.6125 102.2839 -112.6813 96.8978 -112.7607 91.5107 C-112.8129 87.3714 -112.8297 83.2325 -112.8369 79.0929 C-112.8466 77.1069 -112.8699 75.1209 -112.907 73.1352 C-112.9556 70.3546 -112.9539 67.5784 -112.9399 64.7976 C-112.9656 63.9772 -112.9912 63.1567 -113.0176 62.3114 C-112.9755 60.0046 -112.9755 60.0046 -112 56 C-109.5927 53.756 -106.9621 52.3936 -104 51 C-103.1714 50.5409 -102.3429 50.0818 -101.4892 49.6087 C-100.7776 49.2478 -100.0659 48.8868 -99.3328 48.5149 C-98.5041 48.0922 -97.6754 47.6695 -96.8216 47.2341 C-95.9459 46.792 -95.0702 46.35 -94.168 45.8945 C-93.2305 45.4175 -92.293 44.9404 -91.3272 44.4489 C-89.3215 43.4288 -87.315 42.4103 -85.3077 41.3934 C-82.1498 39.7934 -78.994 38.1891 -75.8389 36.5835 C-72.6342 34.9527 -69.4295 33.3222 -66.2242 31.6929 C-57.448 27.2318 -48.6835 22.7485 -39.9289 18.2454 C-37.7757 17.1382 -35.6217 16.0329 -33.4675 14.9277 C-27.5306 11.878 -21.6077 8.8077 -15.7344 5.6367 C-14.8298 5.1499 -13.9252 4.6632 -12.9932 4.1616 C-11.4014 3.3003 -9.8143 2.4304 -8.2334 1.5493 C-3.329 -1.1097 -3.329 -1.1097 0 0 Z \" transform=\"translate(441,331)\" fill=\"#2474d4\"/>\n  <path d=\"M0 0 C0 47.52 0 95.04 0 144 C-6.27 147.3 -12.54 150.6 -19 154 C-21.475 155.3406 -23.95 156.6812 -26.5 158.0625 C-32.7989 161.435 -39.2116 164.4898 -45.6829 167.5107 C-52.0599 170.5074 -58.2898 173.7322 -64.5049 177.0493 C-72.0867 181.0827 -79.7654 184.9125 -87.4656 188.7141 C-93.2897 191.6007 -98.9833 194.628 -104.6074 197.8896 C-107 199 -107 199 -111 199 C-111 151.48 -111 103.96 -111 55 C-99.3743 48.8812 -87.7672 42.8255 -76 37 C-73.076 35.5459 -70.1532 34.0894 -67.2305 32.6328 C-66.4948 32.2663 -65.7591 31.8998 -65.0011 31.5221 C-46.0297 22.0743 -46.0297 22.0743 -27.2273 12.2959 C-21.8446 9.4361 -16.437 6.6303 -11 3.875 C-10.2386 3.4837 -9.4773 3.0924 -8.6929 2.6892 C-3.3487 0 -3.3487 0 0 0 Z \" transform=\"translate(277,112)\" fill=\"#2474d4\"/>\n  <path d=\"M0 0 C1.8897 0.9345 3.775 1.8778 5.6568 2.8281 C6.6899 3.342 7.7231 3.8559 8.7875 4.3853 C12.1955 6.0831 15.5975 7.7923 18.9993 9.5022 C21.3646 10.6848 23.7302 11.8668 26.096 13.0484 C31.0489 15.5241 35.9988 18.0054 40.9468 20.4907 C47.3023 23.6827 53.664 26.8621 60.0277 30.0376 C64.9103 32.4754 69.7898 34.9191 74.6685 37.3647 C77.0141 38.5397 79.3606 39.7131 81.7079 40.8848 C84.979 42.5189 88.2461 44.1607 91.5123 45.8047 C92.4904 46.2915 93.4686 46.7784 94.4764 47.2799 C95.361 47.7272 96.2456 48.1744 97.157 48.6353 C97.9299 49.023 98.7029 49.4106 99.4993 49.8101 C101.261 50.8811 101.261 50.8811 102.261 52.8811 C99.9307 54.2198 97.5969 55.552 95.261 56.8811 C94.3174 57.4245 94.3174 57.4245 93.3548 57.9788 C88.6573 60.6437 83.8722 63.0959 79.0364 65.5005 C73.2743 68.3717 67.5211 71.2597 61.7786 74.1699 C54.6625 77.7757 47.5413 81.3711 40.4162 84.959 C36.1416 87.112 31.8693 89.2697 27.6019 91.437 C23.426 93.5576 19.2444 95.6663 15.0585 97.767 C13.4776 98.563 11.8988 99.3631 10.3223 100.1677 C8.1231 101.2891 5.9168 102.3952 3.7083 103.4981 C2.4597 104.129 1.2111 104.76 -0.0753 105.41 C-5.8608 107.7331 -10.0589 108.4981 -15.9541 106.3333 C-17.467 105.5727 -18.9692 104.7905 -20.4616 103.9905 C-21.2759 103.5749 -22.0902 103.1593 -22.9291 102.7312 C-25.5629 101.3824 -28.1817 100.0069 -30.8015 98.6311 C-32.6208 97.6945 -34.4413 96.7602 -36.2629 95.8281 C-39.8344 94 -43.4019 92.1645 -46.967 90.324 C-52.6277 87.4128 -58.3518 84.6478 -64.114 81.9436 C-75.4376 76.5926 -86.6257 70.9788 -97.8132 65.3499 C-100.483 64.0096 -103.1565 62.6773 -105.8327 61.3499 C-106.5785 60.9795 -107.3243 60.6091 -108.0927 60.2276 C-110.0147 59.2739 -111.9374 58.3216 -113.8601 57.3694 C-116.739 55.8811 -116.739 55.8811 -119.739 53.8811 C-118.739 50.8811 -118.739 50.8811 -116.9992 49.7813 C-116.2456 49.4417 -115.492 49.1021 -114.7155 48.7522 C-113.857 48.3558 -112.9985 47.9594 -112.114 47.551 C-111.2065 47.1443 -110.299 46.7376 -109.364 46.3186 C-102.6928 43.2961 -96.1553 40.0843 -89.6882 36.6467 C-76.8439 29.8306 -63.8779 23.2532 -50.893 16.7099 C-46.9908 14.7433 -43.0922 12.7703 -39.2006 10.7827 C-35.3797 8.8314 -31.5512 6.8957 -27.7168 4.971 C-26.2703 4.2417 -24.8267 3.5069 -23.3859 2.7664 C-21.3851 1.7393 -19.3732 0.7342 -17.3608 -0.27 C-16.2234 -0.8461 -15.086 -1.4221 -13.9142 -2.0157 C-8.499 -3.8972 -4.9908 -2.3253 0 0 Z \" transform=\"translate(167.7389678955078,45.11888122558594)\" fill=\"#2474d4\"/>\n  <path d=\"M0 0 C2.9017 1.317 5.7356 2.6783 8.5754 4.1174 C9.4283 4.5436 10.2811 4.9698 11.1598 5.409 C13.9805 6.8204 16.7969 8.2402 19.6133 9.6602 C21.5854 10.649 23.5577 11.6373 25.5303 12.6251 C30.7333 15.2323 35.9327 17.8467 41.1313 20.4626 C46.3673 23.0959 51.6066 25.7225 56.8457 28.3496 C62.7626 31.3172 68.6792 34.2856 74.5936 37.2583 C75.4972 37.7125 76.4008 38.1666 77.3318 38.6346 C79.0857 39.5165 80.8393 40.3988 82.5926 41.2817 C86.6529 43.325 90.7176 45.358 94.7955 47.3659 C95.9128 47.918 95.9128 47.918 97.0527 48.4811 C99.0488 49.4661 101.0471 50.4467 103.0456 51.427 C106 53 106 53 108 55 C96.2072 61.9866 84.05 68.164 71.8086 74.3164 C70.2485 75.1016 70.2485 75.1016 68.6569 75.9027 C63.1745 78.6617 57.6897 81.4159 52.2029 84.1663 C46.5409 87.0056 40.8875 89.8616 35.2358 92.7214 C30.8748 94.9242 26.5077 97.1146 22.1387 99.3016 C20.0499 100.35 17.9635 101.403 15.8795 102.4608 C12.9788 103.9319 10.0697 105.3851 7.158 106.8342 C6.3003 107.2741 5.4426 107.714 4.5589 108.1671 C-1.2078 111.0051 -1.2078 111.0051 -4.6053 110.9833 C-7.975 109.5997 -11.2176 108.0697 -14.4739 106.4333 C-15.2097 106.0657 -15.9455 105.698 -16.7036 105.3192 C-19.1347 104.1026 -21.5615 102.8775 -23.9883 101.6523 C-25.6913 100.798 -27.3946 99.9442 -29.0982 99.091 C-33.591 96.8388 -38.0801 94.5795 -42.5685 92.3187 C-47.0807 90.0474 -51.5961 87.7827 -56.1113 85.5176 C-62.777 82.1728 -69.4408 78.8244 -76.1028 75.4724 C-84.3948 71.3008 -92.696 67.1478 -101 63 C-103.6668 61.6669 -106.3334 60.3335 -109 59 C-110.7325 58.1337 -110.7325 58.1337 -112.5 57.25 C-113.7375 56.6312 -113.7375 56.6312 -115 56 C-114 53 -114 53 -110.0508 50.8906 C-108.1418 50.0021 -106.2286 49.1229 -104.3125 48.25 C-92.3346 42.648 -80.485 36.8115 -68.6605 30.8939 C-65.6958 29.4104 -62.7294 27.9302 -59.7629 26.4502 C-49.9043 21.5219 -40.0985 16.5096 -30.3562 11.355 C-24.8183 8.4252 -19.267 5.5381 -13.625 2.8125 C-12.8464 2.42 -12.0678 2.0275 -11.2656 1.623 C-6.9333 -0.4655 -4.5886 -1.403 0 0 Z \" transform=\"translate(451,43)\" fill=\"#2474d4\"/>\n</svg>\n");
const faviconTag = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${faviconBytes.toString("base64")}">`;
const shell = `<!doctype html>\n<html lang="en" data-hraness-theme="paper" data-palette="paper" data-theme="light"><head>${faviconTag}<meta name="viewport" content="width=device-width, viewport-fit=cover"><meta name="color-scheme" content="dark light"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow"><title>Oompa</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n`;
const chunk = (name: string, code: string, isEntry = false) => ({
  code, facadeModuleId: isEntry ? entry : null, fileName: `assets/${name}.js`, isEntry, map: null, type: "chunk",
});
const appearance = { sourcePath: "/fixture/tmp/build-app/build-test/appearance.js", source: "(()=>{window.themeReady=true;})();", verifyInputs: () => Promise.resolve() };
const bundle = () => ({ output: [
  chunk("main-abc", 'import("./lazy-def.js");', true),
  chunk("lazy-def", "export const loaded=true;"),
  { fileName: "assets/style-ghi.css", source: ":root{color-scheme:dark}", type: "asset" },
  { fileName: "assets/appearance-jkl.js", source: appearance.source, type: "asset" },
] });
const hashed = (path: string, content: string) => ({ bytes: Buffer.byteLength(content), path, sha256: appSha256(content) });
const packageBytes = Buffer.from('{"name":"@hraness/oompa","version":"0.6.1"}\n');
const sourceMarker = (environment: Readonly<Record<string, string | undefined>> = process.env): AppSourceMarkerEvidence =>
  createAppSourceMarkerEvidence(packageBytes, environment);
const markerBytes = (evidence: AppSourceMarkerEvidence): string => `${JSON.stringify(evidence.marker, null, 2)}\n`;
const publicationOutput = (
  output: readonly AppArtifact[],
  evidence: AppSourceMarkerEvidence,
): readonly AppArtifact[] => [...output, evidence.markerArtifact]
  .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
const complete = () => {
  const graph = snapshotAppGraph(bundle(), entry, appearance);
  return {
    artifacts: [
      ...graph.artifacts.map((item) => ({ ...item, path: `graphs/client/${item.path}` })),
      hashed("index.html", prepareAppShell(shell, graph).replace(APP_CSS_PLACEHOLDER, "/stylex.css")),
    ],
    compilerSha256: "a".repeat(64), finalCss: hashed("stylex.css", "@layer components.hraness-stylex.priority1{.x{color:red}}"),
    generationId: "oompa-app", graphs: [{ id: "client", receiptSha256: "b".repeat(64) }],
    kind: "hraness-stylex-complete-generation", packages: [{ manifestSha256: "e".repeat(64), name: "@hraness/design-kit", version: "0.6.0" }, { manifestSha256: "c".repeat(64), name: "@hraness/ui", version: "0.5.6" }],
    planSha256: "d".repeat(64), schemaVersion: 2, state: "complete",
    unionPolicySha256: "1ceced1f1bf6359413ca6425ede61e1fdae272b897f4455c2347e2431d75caa1",
  };
};

describe("app compiler-owned Vite configuration", () => {
  for (const [profile, configure] of [
    ["production", appProductionConfig],
    ["development", appDevelopmentConfig],
  ] as const) {
    test(`leaves ${profile} Vite root and graph output ownership to the public adapter`, () => {
      const config = configure("/fixture", { directory: "/fixture/generation", planSha256: "a".repeat(64) }, appearance);
      expect(config.root).toBeUndefined();
      expect(config.publicDir).toBeUndefined();
      for (const key of ["assetsInlineLimit", "outDir", "assetsDir", "copyPublicDir", "cssCodeSplit", "emptyOutDir", "lib", "write", "sourcemap"] as const) {
        expect(config.build?.[key]).toBeUndefined();
      }
      expect(config.build?.rollupOptions).toBeUndefined();
      expect(config.build?.target).toBe("es2022");
      expect(config.mode).toBe(profile);
      expect(config.define?.["process.env.NODE_ENV"]).toBe(JSON.stringify(profile));
      expect(config.configFile).toBe(false);
      expect(config.envFile).toBe(false);
      expect(config.build?.minify).toBe(profile === "development" ? false : undefined);
    });
  }
});

describe("app graph output values", () => {
  test("accepts only production or development runs below the exact control directory", () => {
    expect(() => assertAppRunDirectory("/fixture", "/fixture/tmp/build-app/build-abc_123")).not.toThrow();
    expect(() => assertAppRunDirectory("/fixture", "/fixture/tmp/build-app/dev/runs/build-abc_123")).not.toThrow();
    for (const run of [
      "/fixture/build-abc", "/other/tmp/build-app/build-abc", "/fixture-copy/tmp/build-app/build-abc",
      "/fixture/tmp/build-app", "/fixture/tmp/build-app-other/build-abc", "/fixture/tmp/build-app/build-",
      "/fixture/tmp/build-app/build-abc/extra", "/fixture/tmp/build-app/dev/build-abc",
      "/fixture/tmp/build-app/../build-abc", "/fixture/tmp/build-app/dev/runs/../build-abc",
      "/fixture/tmp/build-app/dev\\runs\\build-abc",
    ]) expect(() => assertAppRunDirectory("/fixture", run)).toThrow();
  });

  test("binds the real entry facade, complete foundation, and lazy output bytes", () => {
    const input = bundle();
    const graph = snapshotAppGraph(input, entry, appearance);
    expect(graph.entry).toBe("assets/main-abc.js");
    expect(graph.foundation).toBe("assets/style-ghi.css");
    expect(graph.appearance).toBe("assets/appearance-jkl.js");
    expect(graph.artifacts.map(({ path }) => path)).toEqual(["assets/appearance-jkl.js", "assets/lazy-def.js", "assets/main-abc.js", "assets/style-ghi.css"]);
    const prior = JSON.stringify(graph);
    input.output[0] = chunk("changed", "changed", true);
    expect(JSON.stringify(graph)).toBe(prior);
  });

  test("rejects missing/extra entries, facade forgery, missing/split CSS and maps", () => {
    for (const input of [
      { output: bundle().output.slice(1) },
      { output: [...bundle().output, chunk("extra", "export{}", true)] },
      { output: [{ ...chunk("main", "export{}", true), facadeModuleId: "/other/main.tsx" }, bundle().output[2]] },
      { output: bundle().output.slice(0, 2) },
      { output: [...bundle().output, { fileName: "assets/extra.css", type: "asset", source: "a{}" }] },
      { output: [{ ...chunk("main", "export{}", true), map: {} }, bundle().output[2]] },
    ]) expect(() => snapshotAppGraph(input, entry, appearance)).toThrow();
  });

  test("rejects maps, receipts, source assets, path traversal and duplicate files", () => {
    for (const fileName of ["assets/app.js.map", "assets/source.ts", "assets/source.svg", "stylex-complete.json", "../app.js", "/assets/app.js", "assets/%2e%2e.js", "assets\\app.js", "assets/a.js?x", "assets/a.js#x"]) {
      expect(() => snapshotAppGraph({ output: [...bundle().output, { fileName, type: "asset", source: "x" }] }, entry, appearance)).toThrow();
    }
    expect(() => snapshotAppGraph({ output: [...bundle().output, chunk("lazy-def", "different")] }, entry, appearance)).toThrow();
  });

  test("requires exactly one classic bootstrap with the original compiler bytes", () => {
    const base = bundle().output.filter((item) => item.fileName !== "assets/appearance-jkl.js");
    const bootstrap = { fileName: "assets/appearance-jkl.js", source: appearance.source, type: "asset" };
    for (const output of [
      base,
      [...base, { ...bootstrap, source: `${appearance.source}changed` }],
      [...base, { ...bootstrap, fileName: "assets/other-bootstrap.js" }],
      [...base, bootstrap, { ...bootstrap, fileName: "assets/appearance-other.js" }],
      [...base, chunk("appearance-jkl", appearance.source)],
    ]) expect(() => snapshotAppGraph({ output }, entry, appearance)).toThrow();
    expect(snapshotAppGraph({ output: [...base, { ...bootstrap, source: Buffer.from(appearance.source) }] }, entry, appearance).appearance)
      .toBe(bootstrap.fileName);
  });
});

describe("registered authored shell", () => {
  test("admits only the exact Oompa favicon bytes already held by the shell", async () => {
    const bytes = await readFile(new URL("../site/favicon.svg", import.meta.url));
    const tag = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${bytes.toString("base64")}">`;
    expect(bytes).toEqual(faviconBytes);
    expect(tag).toBe(faviconTag);
    const authored = await readFile(new URL("../app/index.html", import.meta.url), "utf8");
    const graph = snapshotAppGraph(bundle(), entry, appearance);
    for (const mount of ["/", "./"] as const) {
      expect(prepareAppShell(authored, graph, mount)).toContain(tag);
    }
  });

  test("refuses missing, duplicate, alternate, inert, or active-payload favicons", () => {
    const graph = snapshotAppGraph(bundle(), entry, appearance);
    const active = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>').toString("base64");
    for (const changed of [
      shell.replace(faviconTag, ""),
      shell.replace(faviconTag, faviconTag + faviconTag),
      shell.replace(faviconTag, `${faviconTag}<link rel="icon" href="/favicon.svg">`),
      shell.replace(faviconTag, '<link rel="icon" href="https://example.test/favicon.svg">'),
      shell.replace(faviconTag, faviconTag.replace('rel="icon"', 'rel="shortcut icon"')),
      shell.replace(faviconTag, faviconTag.replace('type="image/svg+xml"', 'type="image/png"')),
      shell.replace(faviconTag, faviconTag.replace('href="data:', 'href="/favicon.svg" href="data:')),
      shell.replace(faviconTag, faviconTag.replace(">", ' onload="alert(1)">')),
      shell.replace(faviconTag, faviconTag.replace("base64,", "base64,\n")),
      shell.replace(faviconTag, faviconTag.replace(faviconBytes.toString("base64"), active)),
      shell.replace(faviconTag, faviconTag.replace(faviconBytes.toString("base64"), faviconBytes.toString("base64") + "=")),
      shell.replace(faviconTag, `<!--${faviconTag}-->`),
      shell.replace(faviconTag, `<title>${faviconTag}</title>`),
      shell.replace(faviconTag, `<meta content='${faviconTag}'>`),
      shell.replace(faviconTag, "").replace("</body>", `${faviconTag}</body>`),
      shell.replace("<head>", "<textarea><head>"),
    ]) expect(() => prepareAppShell(changed, graph)).toThrow();
  });

  test("rejects every sampled changed favicon byte under the unchanged finite asset contract", () => {
    const graph = snapshotAppGraph(bundle(), entry, appearance);
    fc.assert(fc.property(
      fc.integer({ min: 0, max: faviconBytes.length - 1 }),
      fc.integer({ min: 1, max: 255 }),
      (offset, delta) => {
        const changed = Buffer.from(faviconBytes);
        changed[offset] = (changed[offset] ?? 0) ^ delta;
        const altered = shell.replace(faviconBytes.toString("base64"), changed.toString("base64"));
        expect(() => prepareAppShell(altered, graph)).toThrow("Unreviewed app favicon bytes");
      },
    ), { seed: 20_260_913, numRuns: 64 });
  });

  test("retains metadata and every other authored byte with foundation before recipes", () => {
    const graph = snapshotAppGraph(bundle(), entry, appearance);
    const rendered = prepareAppShell(shell, graph);
    const foundation = '<link rel="stylesheet" href="/graphs/client/assets/style-ghi.css">';
    const recipes = `<link rel="stylesheet" href="${APP_CSS_PLACEHOLDER}">`;
    const bootstrap = '<script src="/graphs/client/assets/appearance-jkl.js"></script>';
    const paletteClass = getDesignPaletteTheme("paper", "light").className;
    expect(rendered.indexOf(foundation)).toBeLessThan(rendered.indexOf(recipes));
    expect(rendered.indexOf(recipes)).toBeLessThan(rendered.indexOf(bootstrap));
    expect(rendered.indexOf(bootstrap)).toBeLessThan(rendered.indexOf("</head>"));
    expect(rendered).not.toMatch(/<(?:script)[^>]*(?:async|defer)|<style\b|\bstyle=/u);
    expect(rendered.replace(`${foundation}\n    ${recipes}\n    ${bootstrap}\n  `, "")
      .replace(` class="${paletteClass}"`, "")
      .replace("/graphs/client/assets/main-abc.js", "/src/main.tsx")).toBe(shell);
  });

  test("fails closed on ambiguous entry, metadata joins, or injected styles", () => {
    const graph = snapshotAppGraph(bundle(), entry, appearance);
    for (const changed of [
      shell.replace("/src/main.tsx", "/src/other.tsx"),
      shell.replace("</body>", '<script src="/another.js"></script></body>'),
      shell.replace("</head>", "</head></head>"),
      shell.replace("<head>", '<head><link rel="stylesheet" href="/other.css">'),
      shell.replace("<head>", '<head><style>a{color:red}</style>'),
      shell.replace("<head>", '<head><base href="/elsewhere/">'),
      shell.replace('<div id="root">', '<div style="color:red" id="root">'),
      shell.replace("Oompa", APP_CSS_PLACEHOLDER),
      shell.replace('data-palette="paper"', 'data-palette="gruvbox"'),
      shell.replace('data-theme="light"', 'data-theme="dark"'),
      shell.replace('<html lang="en"', '<html class="other" lang="en"'),
      shell.replace('<script type="module" src="/src/main.tsx"></script>', '<!--<script type="module" src="/src/main.tsx"></script>-->'),
    ]) expect(() => prepareAppShell(changed, graph)).toThrow();
  });

  test("seals relative links for an immutable development revision", () => {
    const graph = snapshotAppGraph(bundle(), entry, appearance);
    const rendered = prepareAppShell(shell, graph, "./")
      .replace(APP_CSS_PLACEHOLDER, "./stylex.css");
    expect(rendered).toContain('src="./graphs/client/assets/main-abc.js"');
    expect(rendered).toContain('href="./graphs/client/assets/style-ghi.css"');
    expect(rendered).toContain('href="./stylex.css"');
    expect(rendered).toContain('src="./graphs/client/assets/appearance-jkl.js"');
    expect(rendered).not.toMatch(/(?:src|href)="\/(?:graphs|stylex\.css)/u);
  });
});

describe("closed public projection and prior publication provenance", () => {
  test("keeps compiler output closed while binding one typed marker into publication", () => {
    const input = complete();
    const compilerOutput = parseAppComplete(input);
    expect(compilerOutput.map(({ path }) => path)).toEqual(["graphs/client/assets/appearance-jkl.js", "graphs/client/assets/lazy-def.js", "graphs/client/assets/main-abc.js", "graphs/client/assets/style-ghi.css", "index.html", "stylex.css"]);
    expect(compilerOutput.some(({ path }) => path === APP_SOURCE_MARKER_PATH)).toBe(false);
    const evidence = sourceMarker({ VERCEL: "1", VERCEL_GIT_COMMIT_SHA: "e".repeat(40) });
    const output = publicationOutput(compilerOutput, evidence);
    const source = appPublicationRecord(output, appSha256(shell), appSha256(JSON.stringify(input)), evidence);
    expect(parseAppPublication(JSON.parse(source) as unknown)).toEqual(output);
    expect(source).not.toContain(entry);
    expect(source).not.toContain("inputs");
    expect(source).not.toContain("rootDirectory");
    expect(source).toContain('"path":".well-known/oompa-app.json"');
  });

  test("rejects foreign generations, graph/package metadata, artifact drift and leak paths", () => {
    for (const patch of [
      { schemaVersion: 1 }, { schemaVersion: 3 }, { unionPolicySha256: "e".repeat(64) },
      { unionPolicySha256: undefined }, { state: "building" }, { generationId: "other" }, { rootDirectory: "/private/root" },
      { graphs: [] }, { graphs: [{ id: "ssr", receiptSha256: "b".repeat(64) }] },
      { packages: [{ name: ["@other", "ui"].join("/"), version: "0.5.3", manifestSha256: "c".repeat(64) }] },
      { packages: complete().packages.slice(1) },
      { packages: [...complete().packages].reverse() },
      { packages: [complete().packages[0], complete().packages[0]] },
      { packages: [...complete().packages, complete().packages[0]] },
      { finalCss: hashed("other.css", "x") },
      { artifacts: [...complete().artifacts, hashed("source.ts", "x")] },
      { artifacts: [...complete().artifacts, hashed("stylex-complete.json", "x")] },
      { artifacts: [...complete().artifacts, hashed(APP_SOURCE_MARKER_PATH, "{}\n")] },
      { artifacts: [...complete().artifacts, hashed("graphs/client/assets/app.js.map", "x")] },
      { artifacts: [...complete().artifacts].reverse() },
      { artifacts: [complete().artifacts[0], ...complete().artifacts] },
      { artifacts: complete().artifacts.filter(({ path }) => !path.includes("/appearance-")) },
    ]) expect(() => parseAppComplete({ ...complete(), ...patch })).toThrow();
    for (const bad of [NaN, -1, 0, 1.5, 65 * 1024 * 1024]) {
      expect(() => parseAppComplete({ ...complete(), finalCss: { ...complete().finalCss, bytes: bad } })).toThrow();
    }
    const unbound = Object.fromEntries(Object.entries(complete()).filter(([key]) => key !== "unionPolicySha256"));
    expect(() => parseAppComplete(unbound)).toThrow();
  });

  test("source environment excludes every ASCII control without excluding other code units", () => {
    const controls = [...Array.from({ length: 32 }, (_, code) => code), 127];
    for (const code of controls) {
      expect(() => snapshotAppSourceEnvironment({ VERCEL: `left${String.fromCharCode(code)}right` }))
        .toThrow(/Unsafe app source environment value/u);
    }
    for (const code of [32, 126, 128, 0x2028, 0xd800, 0xdc00, 0xffff]) {
      const value = `left${String.fromCharCode(code)}right`;
      expect(snapshotAppSourceEnvironment({ VERCEL: value }).VERCEL).toBe(value);
    }
    expect(snapshotAppSourceEnvironment({ VERCEL: "x".repeat(256) }).VERCEL).toHaveLength(256);
    expect(() => snapshotAppSourceEnvironment({ VERCEL: "x".repeat(257) }))
      .toThrow(/Unsafe app source environment value/u);
  });

  test("prior output requires the exact private publication schema and safe paths", () => {
    const evidence = sourceMarker();
    const output = publicationOutput(parseAppComplete(complete()), evidence);
    const source: unknown = JSON.parse(appPublicationRecord(output, appSha256(shell), "f".repeat(64), evidence));
    expect(() => parseAppPublication(complete())).toThrow();
    expect(() => parseAppPublication({ ...(source as Record<string, unknown>), sourceRoot: entry })).toThrow();
    expect(() => parseAppPublication({ ...(source as Record<string, unknown>), artifacts: [hashed("../user.txt", "personal")] })).toThrow();
    expect(() => parseAppPublication({ ...(source as Record<string, unknown>), completeSha256: "not-a-digest" })).toThrow();
    expect(() => parseAppPublication({ ...(source as Record<string, unknown>), schemaVersion: 1 })).toThrow();
    expect(() => parseAppPublication({ ...(source as Record<string, unknown>), sourceMarker: undefined })).toThrow();
    expect(() => parseAppPublication({
      ...(source as Record<string, unknown>),
      artifacts: output.filter(({ path }) => path !== APP_SOURCE_MARKER_PATH),
    })).toThrow();
    expect(() => createAppSourceMarkerEvidence(
      Buffer.from('{"name":"oompa","version":"0.6.1"}\n'),
      {},
    )).toThrow(/Oompa root package/u);
    for (const OOMPA_RELEASE_COMMIT of ["x".repeat(257), "safe\u0000hidden"]) {
      expect(() => createAppSourceMarkerEvidence(packageBytes, {
        OOMPA_RELEASE_COMMIT,
        VERCEL: "1",
        VERCEL_GIT_COMMIT_SHA: "e".repeat(40),
      })).toThrow(/Unsafe app source environment value/u);
    }
    const changedEvidence = structuredClone(evidence) as unknown as {
      environment: { OOMPA_RELEASE_COMMIT: string | null };
    };
    changedEvidence.environment.OOMPA_RELEASE_COMMIT = "a".repeat(40);
    expect(() => parseAppPublication({
      ...(source as Record<string, unknown>),
      sourceMarker: changedEvidence,
    })).toThrow();
  });
});

type PublicationFixtureBase = Readonly<{
  app: string;
  control: string;
  next: readonly AppArtifact[];
  pendingMarker: string;
  publish: string;
  root: string;
  run: string;
  sourceMarker: AppSourceMarkerEvidence;
}>;
type PriorPublicationFixture = PublicationFixtureBase & Readonly<{
  old: readonly AppArtifact[];
  previousMarker: Buffer<ArrayBuffer>;
}>;
type FreshPublicationFixture = PublicationFixtureBase & Readonly<{
  old?: never;
  previousMarker?: never;
}>;
type PublicationFixture = PriorPublicationFixture | FreshPublicationFixture;

async function writePublicTree(
  root: string,
  label: string,
  evidence: AppSourceMarkerEvidence,
): Promise<readonly AppArtifact[]> {
  await mkdir(join(root, "graphs", "client", "assets"), { mode: 0o700, recursive: true });
  await mkdir(join(root, ".well-known"), { mode: 0o700 });
  const files = new Map([
    [APP_SOURCE_MARKER_PATH, markerBytes(evidence)],
    ["graphs/client/assets/foundation.css", `@layer base{html{--fixture:${label}}}\n`],
    ["graphs/client/assets/main.js", `globalThis.__fixture=${JSON.stringify(label)};\n`],
    ["index.html", `<!doctype html><link rel="stylesheet" href="/stylex.css"><script type="module" src="/graphs/client/assets/main.js"></script>${label}\n`],
    ["stylex.css", `@layer components.hraness-ui.priority1{.x{color:${label}}}\n`],
  ]);
  for (const [path, contents] of files) {
    await writeFile(join(root, ...path.split("/")), contents, { flag: "wx", mode: 0o600 });
  }
  return readAppInventory(root);
}

function publicationFixture(previous: true): Promise<PriorPublicationFixture>;
function publicationFixture(previous: false): Promise<FreshPublicationFixture>;
async function publicationFixture(previous: boolean): Promise<PublicationFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-build-publication-")));
  temporaryRoots.push(root);
  const app = join(root, "app");
  const control = join(root, "control");
  const run = join(control, "build-fixture");
  const publish = join(run, "public");
  const pendingMarker = join(run, "publication.json");
  await writeFile(join(root, "package.json"), packageBytes, { flag: "wx", mode: 0o600 });
  const marker = sourceMarker();
  await mkdir(app, { mode: 0o700 });
  await mkdir(publish, { mode: 0o700, recursive: true });
  const next = await writePublicTree(publish, "blue", marker);
  await writeFile(
    pendingMarker,
    appPublicationRecord(next, "1".repeat(64), "2".repeat(64), marker),
    { flag: "wx", mode: 0o600 },
  );
  if (!previous) return { app, control, next, pendingMarker, publish, root, run, sourceMarker: marker };
  const dist = join(app, "dist");
  await mkdir(dist, { mode: 0o700 });
  const old = await writePublicTree(dist, "red", marker);
  const previousMarker = Buffer.from(appPublicationRecord(old, "3".repeat(64), "4".repeat(64), marker));
  await writeFile(join(control, "current.json"), previousMarker, { flag: "wx", mode: 0o600 });
  return { app, control, next, old, pendingMarker, previousMarker, publish, root, run, sourceMarker: marker };
}

async function expectSettled(fixture: PublicationFixture): Promise<void> {
  expect(await readAppInventory(join(fixture.app, "dist"))).toEqual(fixture.next);
  const marker = JSON.parse(await readFile(join(fixture.control, "current.json"), "utf8")) as unknown;
  expect(parseAppPublication(marker)).toEqual(fixture.next);
  await expect(lstat(join(fixture.control, "pending-publication.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await lstat(join(fixture.run, "transaction.json"))).isFile()).toBe(true);
  if (fixture.old !== undefined) {
    expect(await readAppInventory(join(fixture.run, "previous-dist"))).toEqual(fixture.old);
    expect(await readFile(join(fixture.run, "previous-publication.json"))).toEqual(fixture.previousMarker);
  }
}

async function withPublicationLock<Value>(
  control: string,
  operation: (lock: AppPublicationLock) => Promise<Value>,
): Promise<Value> {
  const lock = acquireAppPublicationLock(control);
  try { return await operation(lock); } finally { lock.release(); }
}

describe("durable app publication", () => {
  test("a collected custody token clears both exact private records before readmission", async () => {
    const fixture = await publicationFixture(false);
    const dev = join(fixture.control, "dev");
    await mkdir(dev, { mode: 0o700 });
    const buildLock = acquireAppPublicationLock(fixture.control);
    const devLock = acquireAppPublicationLock(dev);
    try {
      const custody = beginAppProcessCustody([
        { controlDirectory: fixture.control, lock: buildLock },
        { controlDirectory: dev, lock: devLock },
      ], "build-fixture");
      const bytes = await readFile(join(fixture.control, APP_PROCESS_CUSTODY_FILE));
      expect(bytes.byteLength).toBeLessThanOrEqual(512);
      expect(JSON.parse(bytes.toString())).toEqual({
        kind: "oompa-app-process-custody", run: "build-fixture", schemaVersion: 1, token: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(await readFile(join(dev, APP_PROCESS_CUSTODY_FILE))).toEqual(bytes);
      for (const directory of [fixture.control, dev]) {
        expect((await lstat(join(directory, APP_PROCESS_CUSTODY_FILE))).mode & 0o777).toBe(0o600);
      }
      custody.assertHeld();
      custody.clearAfterCollection();
      for (const directory of [fixture.control, dev]) {
        await expect(lstat(join(directory, APP_PROCESS_CUSTODY_FILE))).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(() => custody.clearAfterCollection()).toThrow(AppProcessCustodyError);
    } finally { devLock.release(); buildLock.release(); }
    for (const directory of [fixture.control, dev]) acquireAppPublicationLock(directory).release();
  });

  for (const mutation of ["bytes", "identity"] as const) {
    test(`preserves both custody records when ${mutation} change`, async () => {
      const fixture = await publicationFixture(false);
      const dev = join(fixture.control, "dev");
      await mkdir(dev, { mode: 0o700 });
      const buildLock = acquireAppPublicationLock(fixture.control);
      const devLock = acquireAppPublicationLock(dev);
      try {
        const custody = beginAppProcessCustody([
          { controlDirectory: fixture.control, lock: buildLock },
          { controlDirectory: dev, lock: devLock },
        ], "build-fixture");
        const buildPath = join(fixture.control, APP_PROCESS_CUSTODY_FILE);
        const devPath = join(dev, APP_PROCESS_CUSTODY_FILE);
        const original = await readFile(buildPath);
        if (mutation === "identity") {
          await rename(devPath, join(dev, "retained-original.json"));
          await writeFile(devPath, original, { flag: "wx", mode: 0o600 });
        } else {
          const changed = original.toString().replace(/"token":"[a-f0-9]{64}"/u, `"token":"${"0".repeat(64)}"`);
          await writeFile(devPath, changed);
        }
        expect(() => custody.clearAfterCollection()).toThrow(AppProcessCustodyError);
        expect(await readFile(buildPath)).toEqual(original);
        expect((await lstat(devPath)).isFile()).toBe(true);
      } finally { devLock.release(); buildLock.release(); }
      for (const directory of [fixture.control, dev]) {
        expect(() => acquireAppPublicationLock(directory)).toThrow(AppProcessCustodyError);
      }
    });
  }

  test("retains partial pre-spawn custody and refuses malformed existing fences", async () => {
    const fixture = await publicationFixture(false);
    const dev = join(fixture.control, "dev");
    await mkdir(dev, { mode: 0o700 });
    const buildLock = acquireAppPublicationLock(fixture.control);
    const devLock = acquireAppPublicationLock(dev);
    const foreign = "preserve this unknown record\n";
    await writeFile(join(dev, APP_PROCESS_CUSTODY_FILE), foreign, { mode: 0o600 });
    try {
      expect(() => beginAppProcessCustody([
        { controlDirectory: fixture.control, lock: buildLock },
        { controlDirectory: dev, lock: devLock },
      ], "build-fixture")).toThrow(AppProcessCustodyError);
      expect((await readFile(join(fixture.control, APP_PROCESS_CUSTODY_FILE))).byteLength).toBeLessThanOrEqual(512);
      expect(await readFile(join(dev, APP_PROCESS_CUSTODY_FILE), "utf8")).toBe(foreign);
    } finally { devLock.release(); buildLock.release(); }
    for (const directory of [fixture.control, dev]) {
      expect(() => acquireAppPublicationLock(directory)).toThrow(AppProcessCustodyError);
    }
  });

  test("fences initial source-marker inputs across the compiler interval before marker emission", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-build-source-inputs-")));
    temporaryRoots.push(root);
    await writeFile(join(root, "package.json"), packageBytes, { flag: "wx", mode: 0o600 });
    const evidence = sourceMarker();
    await expect(revalidateAppSourceMarkerInputs(root, evidence)).resolves.toBeUndefined();
    await writeFile(join(root, "package.json"), '{"name":"@hraness/oompa","version":"0.6.1"} \n');
    await expect(revalidateAppSourceMarkerInputs(root, evidence)).rejects.toThrow(/source-marker inputs changed/u);
    await writeFile(join(root, "package.json"), packageBytes);
    const changedCommit = evidence.marker.source.commit === "a".repeat(40)
      ? "b".repeat(40)
      : "a".repeat(40);
    await expect(revalidateAppSourceMarkerInputs(
      root,
      evidence,
      { OOMPA_RELEASE_COMMIT: changedCommit },
    )).rejects.toThrow(/source-marker inputs changed/u);
    await expect(lstat(join(root, APP_SOURCE_MARKER_PATH))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("revalidates exact package, environment, and marker bytes before publication intent", async () => {
    const fixture = await publicationFixture(false);
    await expect(revalidateAppSourceMarker(
      fixture.root,
      fixture.publish,
      fixture.sourceMarker,
      process.env,
    )).resolves.toBeUndefined();
    const changedCommit = fixture.sourceMarker.marker.source.commit === "a".repeat(40)
      ? "b".repeat(40)
      : "a".repeat(40);
    await expect(revalidateAppSourceMarker(
      fixture.root,
      fixture.publish,
      fixture.sourceMarker,
      { OOMPA_RELEASE_COMMIT: changedCommit },
    )).rejects.toThrow(/source-marker inputs changed/u);
    await writeFile(join(fixture.root, "package.json"), '{ "name":"@hraness/oompa", "version":"0.6.1" }\n');
    await expect(withPublicationLock(fixture.control, async (lock) => {
      await commitAppPublication({
        appDirectory: fixture.app,
        controlDirectory: fixture.control,
        lock,
        pendingMarkerPath: fixture.pendingMarker,
        projected: fixture.next,
        publishDirectory: fixture.publish,
        rootDirectory: fixture.root,
        sourceMarker: fixture.sourceMarker,
      });
    })).rejects.toThrow(/source-marker inputs changed/u);
    await expect(lstat(join(fixture.control, "pending-publication.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readAppInventory(fixture.publish)).toEqual(fixture.next);
  });

  test("keeps one kernel-released lock inode and serializes live publishers", async () => {
    const fixture = await publicationFixture(false);
    const first = acquireAppPublicationLock(fixture.control);
    expect(() => acquireAppPublicationLock(fixture.control)).toThrow(/execution lock/u);
    first.release();
    const identity = await lstat(join(fixture.control, "publication.lock"));
    expect({ mode: identity.mode & 0o777, size: identity.size }).toEqual({ mode: 0o600, size: 0 });
    const second = acquireAppPublicationLock(fixture.control);
    second.assertHeld();
    second.release();
    const after = await lstat(join(fixture.control, "publication.lock"));
    expect([after.dev, after.ino]).toEqual([identity.dev, identity.ino]);
  });

  test("reacquires the persistent lock after its holder process dies", async () => {
    const fixture = await publicationFixture(false);
    const ready = join(fixture.root, "holder-ready");
    const moduleUrl = new URL("./build-app.ts", import.meta.url).href;
    const holder = Bun.spawn([
      process.execPath,
      "-e",
      `const {writeFile}=await import("node:fs/promises");const m=await import(${JSON.stringify(moduleUrl)});m.acquireAppPublicationLock(${JSON.stringify(fixture.control)});await writeFile(${JSON.stringify(ready)},"ready",{flag:"wx",mode:384});await new Promise(()=>{});`,
    ], { stderr: "inherit", stdout: "inherit" });
    let exited = false;
    try {
      for (let attempt = 0; attempt < 100 && await lstat(ready).then(() => false, () => true); attempt += 1) {
        await Bun.sleep(10);
      }
      expect(await readFile(ready, "utf8")).toBe("ready");
      expect(() => acquireAppPublicationLock(fixture.control)).toThrow(/execution lock/u);
      holder.kill("SIGKILL");
      await holder.exited;
      exited = true;
      const recovered = acquireAppPublicationLock(fixture.control);
      recovered.assertHeld();
      recovered.release();
      expect((await lstat(join(fixture.control, "publication.lock"))).isFile()).toBe(true);
    } finally {
      if (!exited) {
        holder.kill("SIGKILL");
        await holder.exited;
      }
    }
  });

  test("publishes a first exact output and retains its settled transaction", async () => {
    const fixture = await publicationFixture(false);
    await withPublicationLock(fixture.control, async (lock) => {
      await commitAppPublication({
        appDirectory: fixture.app,
        controlDirectory: fixture.control,
        lock,
        pendingMarkerPath: fixture.pendingMarker,
        projected: fixture.next,
        publishDirectory: fixture.publish,
        rootDirectory: fixture.root,
        sourceMarker: fixture.sourceMarker,
      });
    });
    await expectSettled(fixture);
  });

  test("recovers every exact prior-output rename boundary by rolling forward", async () => {
    const boundaries: readonly AppPublicationFailureBoundary[] = ["journal", "previous", "public", "marker"];
    for (const failAfter of boundaries) {
      const fixture = await publicationFixture(true);
      await expect(withPublicationLock(fixture.control, async (lock) => {
        await commitAppPublication({
          appDirectory: fixture.app,
          controlDirectory: fixture.control,
          failAfter,
          lock,
          pendingMarkerPath: fixture.pendingMarker,
          previousMarker: fixture.previousMarker,
          projected: fixture.next,
          publishDirectory: fixture.publish,
          rootDirectory: fixture.root,
          sourceMarker: fixture.sourceMarker,
        });
      })).rejects.toThrow(`Injected app publication failure after ${failAfter}`);
      expect((await lstat(join(fixture.control, "pending-publication.json"))).isFile()).toBe(true);
      await withPublicationLock(fixture.control, async (lock) => {
        await reconcileAppPublication(fixture.app, fixture.control, lock);
      });
      await expectSettled(fixture);
    }
  });

  test("recovers every exact first-publication rename boundary", async () => {
    const boundaries: readonly AppPublicationFailureBoundary[] = ["journal", "public", "marker"];
    for (const failAfter of boundaries) {
      const fixture = await publicationFixture(false);
      await expect(withPublicationLock(fixture.control, async (lock) => {
        await commitAppPublication({
          appDirectory: fixture.app,
          controlDirectory: fixture.control,
          failAfter,
          lock,
          pendingMarkerPath: fixture.pendingMarker,
          projected: fixture.next,
          publishDirectory: fixture.publish,
          rootDirectory: fixture.root,
          sourceMarker: fixture.sourceMarker,
        });
      })).rejects.toThrow(`Injected app publication failure after ${failAfter}`);
      await withPublicationLock(fixture.control, async (lock) => {
        await reconcileAppPublication(fixture.app, fixture.control, lock);
      });
      await expectSettled(fixture);
    }
  });

  test("preserves an interrupted transaction when any staged byte changes", async () => {
    const fixture = await publicationFixture(true);
    await expect(withPublicationLock(fixture.control, async (lock) => {
      await commitAppPublication({
        appDirectory: fixture.app,
        controlDirectory: fixture.control,
        failAfter: "previous",
        lock,
        pendingMarkerPath: fixture.pendingMarker,
        previousMarker: fixture.previousMarker,
        projected: fixture.next,
        publishDirectory: fixture.publish,
        rootDirectory: fixture.root,
        sourceMarker: fixture.sourceMarker,
      });
    })).rejects.toThrow("after previous");
    await writeFile(fixture.pendingMarker, "{}\n", { mode: 0o600 });
    await expect(withPublicationLock(fixture.control, async (lock) => {
      await reconcileAppPublication(fixture.app, fixture.control, lock);
    })).rejects.toThrow(/digest changed/u);
    expect(await readAppInventory(join(fixture.run, "previous-dist"))).toEqual(fixture.old);
    expect(await readAppInventory(fixture.publish)).toEqual(fixture.next);
    expect(await readFile(join(fixture.control, "current.json"))).toEqual(fixture.previousMarker);
    expect((await lstat(join(fixture.control, "pending-publication.json"))).isFile()).toBe(true);
  });

  test("refuses a hardlinked pending marker before publishing an intent", async () => {
    const fixture = await publicationFixture(false);
    await link(fixture.pendingMarker, join(fixture.run, "marker-alias.json"));
    await expect(withPublicationLock(fixture.control, async (lock) => {
      await commitAppPublication({
        appDirectory: fixture.app,
        controlDirectory: fixture.control,
        lock,
        pendingMarkerPath: fixture.pendingMarker,
        projected: fixture.next,
        publishDirectory: fixture.publish,
        rootDirectory: fixture.root,
        sourceMarker: fixture.sourceMarker,
      });
    })).rejects.toThrow(/Hardlinked/u);
    await expect(lstat(join(fixture.control, "pending-publication.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(fixture.app, "dist"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
