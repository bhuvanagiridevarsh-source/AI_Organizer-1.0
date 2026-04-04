# PyInstaller hook for tkinter
# Ensures Tcl/Tk libraries are properly bundled on macOS

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, collect_dynamic_libs

# Collect all tkinter submodules
hiddenimports = collect_submodules('tkinter')

# Collect tkinter data files
datas = collect_data_files('tkinter')

# Collect dynamic libraries
binaries = collect_dynamic_libs('tkinter')
