// Copy this file to config.h and edit it. config.h is not committed.
#pragma once

// How the Core2 finds the QZ1.
//
// Option A (faster and more reliable): the QZ1's Bluetooth address. Read it on
// the Mac: Apple menu > hold Option > Bluetooth, or System Information >
// Bluetooth, with the QZ1 paired. Write the six bytes in order.
// #define QZ1_ADDRESS { 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF }
//
// Option B: its Bluetooth name, as it appears when pairing (a scan by name
// takes several seconds per attempt).
// Each unit has its own name ("QZ1-xxx"): use the one that is switched on.
#define QZ1_NAME "QZ1"

// Pairing. The legacy PIN 1234 was configured when the Core2 first connected to a real
// QZ1 (some receivers use 0000); newer ones use "just works" pairing (set QZ1_USE_SSP to 1).
#define QZ1_PIN "1234"
#define QZ1_USE_SSP 0

// The Core2's own Wi-Fi. The password is NOT set here: on first start the Core2
// makes a random one, keeps it, and shows it (and a join QR code) on its screen.
#define DEVICE_NAME "QZ1-Bridge"
#define AP_SSID_PREFIX "QZ1-Bridge"
