#include "bindings/bindings.h"

extern "C" void reflect_start_native_diagnostics(void);
extern "C" void reflect_install_scene_entry_points(void);

int main(int argc, char * argv[]) {
	reflect_start_native_diagnostics();
	reflect_install_scene_entry_points();
	ffi::start_app();
	return 0;
}
