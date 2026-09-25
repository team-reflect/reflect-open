#include "bindings/bindings.h"

extern "C" void reflect_start_native_diagnostics(void);
extern "C" void reflect_observe_scene_windows(void);

int main(int argc, char * argv[]) {
	reflect_start_native_diagnostics();
	reflect_observe_scene_windows();
	ffi::start_app();
	return 0;
}
