# PyInstaller hook for ttkbootstrap
# Ensures all ttkbootstrap themes and assets are bundled

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

# Collect all ttkbootstrap submodules
hiddenimports = collect_submodules('ttkbootstrap')

# Collect ttkbootstrap data files (themes, etc.)
datas = collect_data_files('ttkbootstrap')
