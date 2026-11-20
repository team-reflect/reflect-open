// Closes an iPhone Duo simulator, so its outer screen shows. It runs inside
// the simulator and posts the vendor-defined HID event that the hinge slider
// of the Simulator app sends, at 0 degrees. Private API, from
// https://github.com/artemnovichkov/hinge
//
//   xcrun simctl spawn <udid> duo-close
#import <Foundation/Foundation.h>
#include <mach/mach_time.h>
#include <unistd.h>

typedef struct __IOHIDEvent *IOHIDEventRef;
typedef struct __IOHIDEventSystemClient *IOHIDEventSystemClientRef;
extern IOHIDEventRef IOHIDEventCreateVendorDefinedEvent(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t,
    const uint8_t *, CFIndex, uint32_t);
extern IOHIDEventSystemClientRef IOHIDEventSystemClientCreateWithType(CFAllocatorRef, int, CFDictionaryRef);
extern void IOHIDEventSystemClientDispatchEvent(IOHIDEventSystemClientRef, IOHIDEventRef);
extern CFDataRef IOCFSerialize(CFTypeRef, CFOptionFlags);

int main(void) {
    IOHIDEventSystemClientRef client = IOHIDEventSystemClientCreateWithType(NULL, 4, NULL);
    if (!client) { fprintf(stderr, "duo-close: no HID client\n"); return 1; }
    NSDictionary *payload = @{
        @"provider": @"com.apple.Virtualization.VirtualMachines",
        @"source": @"hinge-slider-control",
        @"type": @"range",
        @"value": @0,
    };
    CFDataRef data = IOCFSerialize((__bridge CFTypeRef)payload, 1);
    IOHIDEventRef event = IOHIDEventCreateVendorDefinedEvent(NULL, mach_absolute_time(), 0xFF61, 0x5B, 0,
        CFDataGetBytePtr(data), CFDataGetLength(data), 0);
    IOHIDEventSystemClientDispatchEvent(client, event);
    usleep(20000);
    return 0;
}
