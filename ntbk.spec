# -*- mode: python ; coding: utf-8 -*-
"""
Packaging ntbk as a macOS .app.

Three things PyInstaller cannot work out on its own:

1. `frontend/dist` is read at runtime off disk, so it has to be carried as
   data. app.py's resource() finds it through sys._MEIPASS once frozen.

2. Every services import in bridge.py is INSIDE a function — deliberately, so
   a missing pty or a slow import never delays startup. Imports that only
   happen at call time are invisible to static analysis, so they are listed
   as hidden.

3. pywebview ships its own PyInstaller hook, which is why the Cocoa/WebKit
   bridge comes along without being named here.
"""

block_cipher = None

a = Analysis(
    ["ntbk/app.py"],
    pathex=["ntbk"],            # so `from bridge import Api` resolves flat
    binaries=[],
    datas=[
        ("frontend/dist", "frontend/dist"),
    ],
    hiddenimports=[
        "bridge",
        "services",
        "services.companion",
        "services.runner",
        "services.terminal",
        "bottle",               # pulled in by companion mode at call time
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "PyQt5", "PyQt6", "PySide2", "PySide6", "matplotlib"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="ntbk",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,              # no terminal window behind the app
    disable_windowed_traceback=False,
    argv_emulation=True,        # lets a double-clicked .ntbk arrive in sys.argv
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe, a.binaries, a.datas,
    strip=False, upx=False, name="ntbk",
)

app = BUNDLE(
    coll,
    name="ntbk.app",
    icon=None,
    bundle_identifier="com.zehacksmith.ntbk",
    info_plist={
        "CFBundleName": "ntbk",
        "CFBundleDisplayName": "ntbk",
        "CFBundleShortVersionString": "0.1.0",
        "NSHighResolutionCapable": True,
        # Declares .ntbk so double-clicking a notebook opens it here —
        # document_argument() in app.py already reads it off the command line.
        "CFBundleDocumentTypes": [{
            "CFBundleTypeName": "ntbk notebook",
            "CFBundleTypeRole": "Editor",
            "LSHandlerRank": "Owner",
            "CFBundleTypeExtensions": ["ntbk"],
        }],
    },
)
