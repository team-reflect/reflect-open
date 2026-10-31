#include "bindings/bindings.h"

extern "C" void reflect_start_native_diagnostics(void);

int main(int argc, char * argv[]) {
	reflect_start_native_diagnostics();
	ffi::start_app();
	return 0;
}
