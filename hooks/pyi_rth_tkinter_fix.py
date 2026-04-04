# Runtime hook for Tcl/Tk initialization on macOS
import os
import sys

def _setup_tcl_tk():
    """Set up Tcl/Tk environment variables before tkinter imports"""
    if not getattr(sys, 'frozen', False):
        return

    bundle_dir = sys._MEIPASS

    # Search for init.tcl to find Tcl library
    for root, dirs, files in os.walk(bundle_dir):
        if 'init.tcl' in files:
            if 'tcl' in os.path.basename(root).lower():
                os.environ['TCL_LIBRARY'] = root
            elif 'tk' in os.path.basename(root).lower():
                os.environ['TK_LIBRARY'] = root

    # Fallback paths
    tcl_paths = ['tcl', 'tcl8.6', 'tcl8.5', 'lib/tcl8.6']
    tk_paths = ['tk', 'tk8.6', 'tk8.5', 'lib/tk8.6']

    if 'TCL_LIBRARY' not in os.environ:
        for p in tcl_paths:
            path = os.path.join(bundle_dir, p)
            if os.path.isdir(path):
                os.environ['TCL_LIBRARY'] = path
                break

    if 'TK_LIBRARY' not in os.environ:
        for p in tk_paths:
            path = os.path.join(bundle_dir, p)
            if os.path.isdir(path):
                os.environ['TK_LIBRARY'] = path
                break

_setup_tcl_tk()
