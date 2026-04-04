# PyInstaller hook for _tkinter
# Ensures the _tkinter C extension and Tcl/Tk are bundled

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs
import sys
import os

# Collect _tkinter binaries
binaries = collect_dynamic_libs('_tkinter')

# On macOS, we need to ensure Tcl/Tk framework is available
if sys.platform == 'darwin':
    # Add Tcl/Tk framework paths
    tcl_tk_paths = [
        '/System/Library/Frameworks/Tcl.framework',
        '/System/Library/Frameworks/Tk.framework',
        '/Library/Frameworks/Tcl.framework',
        '/Library/Frameworks/Tk.framework',
    ]

    for path in tcl_tk_paths:
        if os.path.exists(path):
            # Framework exists, PyInstaller should handle it
            pass
