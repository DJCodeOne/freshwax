@echo off
bcdedit /store D:BootBCD /set {bootmgr} device partition=DeviceHarddiskVolume1
bcdedit /store D:BootBCD /set {default} device partition=DeviceHarddiskVolume1
bcdedit /store D:BootBCD /set {default} osdevice partition=DeviceHarddiskVolume1
echo Done
pause
