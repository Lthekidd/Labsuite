param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('foreground', 'restore-foreground', 'scan', 'open-account-switcher', 'list-account-switcher', 'switch-account', 'dismiss', 'open-export', 'open-format', 'select-json', 'open-date', 'select-date', 'start-export')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$PayloadPath,

  [Parameter(Mandatory = $false)]
  [string]$ResultPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName Accessibility

# Telegram Desktop uses a custom Qt popup for its chat menu. The popup is
# available through MSAA even though it is intentionally absent from the UIA
# tree. Invoking the named item is both more reliable and much safer than
# counting keyboard rows near Clear history / Delete chat.
Add-Type -ReferencedAssemblies Accessibility @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Accessibility;

public static class LabSuiteTelegramAccessibility {
  public delegate bool EnumWindowsProc(IntPtr handle, IntPtr state);

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

  [DllImport("user32.dll")]
  private static extern int GetClassName(IntPtr handle, StringBuilder className, int maxCount);

  [DllImport("oleacc.dll")]
  private static extern int AccessibleObjectFromWindow(
    IntPtr handle,
    uint objectId,
    ref Guid interfaceId,
    [In, Out, MarshalAs(UnmanagedType.IUnknown)] ref object accessible
  );

  [DllImport("oleacc.dll")]
  private static extern int AccessibleChildren(
    IAccessible parent,
    int start,
    int count,
    [Out] object[] children,
    out int obtained
  );

  [DllImport("user32.dll")]
  private static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll")]
  private static extern bool GetCursorPos(out POINT point);

  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  private static extern bool SetForegroundWindow(IntPtr handle);

  [DllImport("user32.dll")]
  private static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extraInfo);

  private struct POINT {
    public int X;
    public int Y;
  }

  private static IntPtr FindPopup(uint processId) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((handle, state) => {
      uint candidateProcessId;
      GetWindowThreadProcessId(handle, out candidateProcessId);
      if (candidateProcessId != processId) return true;

      var className = new StringBuilder(256);
      GetClassName(handle, className, className.Capacity);
      if (className.ToString().Contains("QWindowPopupSaveBits")) {
        found = handle;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  private static IAccessible GetAccessibleRoot(IntPtr handle) {
    var interfaceId = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
    object accessible = null;
    int result = AccessibleObjectFromWindow(handle, 0xFFFFFFFC, ref interfaceId, ref accessible);
    if (result != 0) Marshal.ThrowExceptionForHR(result);
    return (IAccessible)accessible;
  }

  private static object[] GetChildren(IAccessible parent) {
    var children = new object[parent.accChildCount];
    int obtained;
    int result = AccessibleChildren(parent, 0, children.Length, children, out obtained);
    if (result < 0) Marshal.ThrowExceptionForHR(result);
    Array.Resize(ref children, obtained);
    return children;
  }

  private static bool InvokeByName(IAccessible parent, string target) {
    foreach (object child in GetChildren(parent)) {
      var nested = child as IAccessible;
      if (nested != null) {
        string name = (nested.get_accName(0) ?? "").Trim();
        if (String.Equals(name, target, StringComparison.OrdinalIgnoreCase)) {
          nested.accDoDefaultAction(0);
          return true;
        }
        if (InvokeByName(nested, target)) return true;
      } else {
        string name = (parent.get_accName(child) ?? "").Trim();
        if (String.Equals(name, target, StringComparison.OrdinalIgnoreCase)) {
          parent.accDoDefaultAction(child);
          return true;
        }
      }
    }
    return false;
  }

  public static bool InvokePopupItem(uint processId, string name) {
    IntPtr popup = FindPopup(processId);
    if (popup == IntPtr.Zero) return false;
    return InvokeByName(GetAccessibleRoot(popup), name);
  }

  public static void Wheel(int x, int y, int delta) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0800, 0, 0, unchecked((uint)delta), UIntPtr.Zero);
  }

  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(80);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }

  public static long ForegroundHandle() {
    return GetForegroundWindow().ToInt64();
  }

  public static string CursorPosition() {
    POINT point;
    GetCursorPos(out point);
    return point.X + "," + point.Y;
  }

  public static bool RestoreWindow(long handle, int cursorX, int cursorY) {
    SetCursorPos(cursorX, cursorY);
    if (handle == 0) return false;
    return SetForegroundWindow(new IntPtr(handle));
  }
}
'@

function Get-TelegramProcess {
  $process = Get-Process Telegram -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1

  if (-not $process) {
    $existingProc = Get-Process Telegram -ErrorAction SilentlyContinue | Select-Object -First 1
    $procPath = if ($existingProc -and $existingProc.Path) { $existingProc.Path } else { $null }

    $candidates = @(
      $procPath,
      (Join-Path $env:APPDATA 'Telegram Desktop\Telegram.exe'),
      (Join-Path $env:LOCALAPPDATA 'Telegram Desktop\Telegram.exe'),
      (Join-Path $env:ProgramFiles 'Telegram Desktop\Telegram.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Telegram Desktop\Telegram.exe')
    )

    $regPath = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -like '*Telegram*' -and $_.InstallLocation } |
      ForEach-Object { Join-Path $_.InstallLocation 'Telegram.exe' } |
      Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($regPath) { $candidates += $regPath }

    $executable = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    if (-not $executable) {
      throw 'Telegram Desktop is not running and its executable was not found.'
    }

    Start-Process -FilePath $executable | Out-Null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
      Start-Sleep -Milliseconds 500
      $process = Get-Process Telegram -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1
      if ($process) { break }
    }
  }

  if (-not $process) { throw 'Telegram Desktop did not open a usable window.' }
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shell.AppActivate($process.Id) | Out-Null
  } catch {}
  return $process
}

function Get-Root([System.Diagnostics.Process]$Process) {
  return [System.Windows.Automation.AutomationElement]::FromHandle($Process.MainWindowHandle)
}

function Get-Descendants($Root, $ControlType) {
  $condition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    $ControlType
  )
  return $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Find-ByName($Root, $ControlType, [string]$Name) {
  $condition = [System.Windows.Automation.AndCondition]::new(
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      $ControlType
    ),
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      $Name
    )
  )
  return $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Invoke-Element($Element) {
  if (-not $Element) { return $false }
  $pattern = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    $pattern.Invoke()
    return $true
  }
  $selection = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
    $selection.Select()
    return $true
  }
  return $false
}

function Get-ElementValue($Element) {
  $pattern = $null
  if ($Element -and $Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
    return [string]$pattern.Current.Value
  }
  return ''
}

function Get-ElementTextCandidates($Element) {
  $values = @()
  if (-not $Element) { return $values }
  try { $values += [string]$Element.Current.Name } catch {}
  try { $values += [string]$Element.Current.HelpText } catch {}
  try { $values += [string]$Element.Current.ItemStatus } catch {}
  try { $values += Get-ElementValue $Element } catch {}
  return @($values | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() } | Select-Object -Unique)
}

function Get-DialogTextEntries($Root) {
  $entries = @()
  $elements = $Root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  foreach ($element in $elements) {
    foreach ($text in @(Get-ElementTextCandidates $element)) {
      $entries += [pscustomobject]@{
        Text = [string]$text
        Element = $element
      }
    }
  }
  return $entries
}

function Get-ExportSettingsInfo($Root) {
  $format = ''
  $path = ''
  $formatElement = $null
  foreach ($entry in @(Get-DialogTextEntries $Root)) {
    $text = [string]$entry.Text
    if (-not $format -and $text -match '(?is)(?:^|\s)Format\s*:\s*([^,\r\n]+)') {
      $format = $Matches[1].Trim()
      $formatElement = $entry.Element
    }
    if (-not $path -and $text -match '(?is)(?:^|\s)Path\s*:\s*(.+?)\s*$') {
      $path = $Matches[1].Trim()
    }
  }
  return [ordered]@{
    format = $format
    path = $path
    formatElement = $formatElement
  }
}

function Test-JsonExportFormat([string]$Format) {
  return [bool]($Format -and $Format -match '(?i)\bJSON\b')
}

function Set-ElementValue($Element, [string]$Value) {
  $pattern = $null
  if (-not $Element -or -not $Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
    return $false
  }
  $pattern.SetValue($Value)
  return $true
}

function Get-ChatFields($ListItem) {
  $result = [ordered]@{}
  $children = $ListItem.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::DataItem
    )
  )
  foreach ($child in $children) {
    $key = [string]$child.Current.Name
    if (-not $key) { continue }
    $result[$key] = Get-ElementValue $child
  }
  return $result
}

function Get-ChatsList($Root) {
  return Find-ByName $Root ([System.Windows.Automation.ControlType]::List) 'Chats'
}

function Get-VisibleChats($Root) {
  $list = Get-ChatsList $Root
  if (-not $list) { throw 'Telegram chat list is not available. Close any Telegram dialog and try again.' }
  $items = $list.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::ListItem
    )
  )
  $chats = @()
  foreach ($item in $items) {
    if ($item.Current.IsOffscreen) { continue }
    $fields = Get-ChatFields $item
    $name = [string]$fields.Name
    if (-not $name) { continue }
    $chats += [ordered]@{
      name = $name
      type = if ($fields.Type) { [string]$fields.Type } elseif ($name -eq 'Saved Messages') { 'Saved Messages' } else { 'Chat' }
      preview = [string]$fields.Message
      time = [string]$fields.Time
      unread = [string]$fields.Unread
      muted = [string]$fields.Muted
    }
  }
  return $chats
}

function Open-MainMenu($Root) {
  $button = Find-ByName $Root ([System.Windows.Automation.ControlType]::Button) 'Main menu'
  if (-not (Invoke-Element $button)) { throw 'Telegram Main menu could not be opened.' }
  Start-Sleep -Milliseconds 350
}

function Get-AccountDetails($Process) {
  $root = Get-Root $Process
  Open-MainMenu $root
  $root = Get-Root $Process
  $profile = Find-ByName $root ([System.Windows.Automation.ControlType]::Button) 'My Profile'
  if (-not (Invoke-Element $profile)) {
    [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
    return [ordered]@{ name = 'Telegram account'; identity = 'Telegram account' }
  }
  Start-Sleep -Milliseconds 600

  $root = Get-Root $Process
  $labels = Get-Descendants $root ([System.Windows.Automation.ControlType]::Text)
  $photo = Find-ByName $root ([System.Windows.Automation.ControlType]::Button) 'Profile Photo'
  $photoRect = if ($photo) { $photo.Current.BoundingRectangle } else { $null }
  $identity = ''
  foreach ($label in $labels) {
    $candidate = ([string]$label.Current.Name).Trim()
    if ($candidate -match '^\+[\d\s()\-]+$') { $identity = $candidate }
  }
  $accountName = ''
  foreach ($label in $labels) {
    $rect = $label.Current.BoundingRectangle
    $candidate = ([string]$label.Current.Name).Trim()
    if (-not $candidate -or $candidate -eq 'online') { continue }
    if ($photoRect -and $rect.X -ge ($photoRect.X - 10) -and $rect.Y -ge ($photoRect.Y + 78) -and $rect.Y -le ($photoRect.Y + 103)) {
      $accountName = $candidate
      break
    }
  }
  $closePanel = Find-ByName $root ([System.Windows.Automation.ControlType]::Button) 'Close panel'
  if (-not (Invoke-Element $closePanel)) { [System.Windows.Forms.SendKeys]::SendWait('{ESC}') }
  Start-Sleep -Milliseconds 250
  if (-not $accountName) { $accountName = 'Telegram account' }
  if (-not $identity) { $identity = $accountName }
  return [ordered]@{ name = $accountName; identity = $identity }
}

function Scan-CurrentAccount($Process, [int]$MaxScrolls) {
  $root = Get-Root $Process
  $account = Get-AccountDetails $Process
  $accountName = [string]$account.name
  $seen = [ordered]@{}
  $unchanged = 0

  for ($scroll = 0; $scroll -le $MaxScrolls; $scroll++) {
    $root = Get-Root $Process
    $before = $seen.Count
    foreach ($chat in (Get-VisibleChats $root)) {
      $key = ($chat.type + "`n" + $chat.name).ToLowerInvariant()
      $seen[$key] = $chat
    }
    if ($seen.Count -eq $before) { $unchanged++ } else { $unchanged = 0 }
    if ($unchanged -ge 3 -or $scroll -eq $MaxScrolls) { break }

    $list = Get-ChatsList $root
    $rect = $list.Current.BoundingRectangle
    [LabSuiteTelegramAccessibility]::Wheel(
      [int]($rect.X + ($rect.Width / 2)),
      [int]($rect.Y + ($rect.Height / 2)),
      -480
    )
    Start-Sleep -Milliseconds 300
  }

  $savedKey = "saved messages`nsaved messages"
  if (-not $seen.Contains($savedKey)) {
    $seen[$savedKey] = [ordered]@{
      name = 'Saved Messages'
      type = 'Saved Messages'
      preview = ''
      time = ''
      unread = ''
      muted = ''
    }
  }

  return [ordered]@{
    name = $accountName
    identity = [string]$account.identity
    chats = @($seen.Values)
  }
}

function Open-AccountSwitcher($Process) {
  $root = Get-Root $Process
  Open-MainMenu $root
  $root = Get-Root $Process
  $window = $root.Current.BoundingRectangle
  $shell = New-Object -ComObject WScript.Shell
  $shell.AppActivate($Process.Id) | Out-Null
  Start-Sleep -Milliseconds 120
  [LabSuiteTelegramAccessibility]::Click(
    [int]($window.X + [Math]::Min(260, $window.Width - 30)),
    [int]($window.Y + 127)
  )
  Start-Sleep -Milliseconds 500
  return [ordered]@{ opened = $true }
}

function Get-AccountSwitcherButtons($Process) {
  $root = Get-Root $Process
  $window = $root.Current.BoundingRectangle
  $buttons = Get-Descendants $root ([System.Windows.Automation.ControlType]::Button)
  $profileY = [double]::PositiveInfinity
  foreach ($button in $buttons) {
    if ($button.Current.Name -eq 'My Profile') {
      $profileY = $button.Current.BoundingRectangle.Y
      break
    }
  }

  $accounts = @()
  foreach ($button in $buttons) {
    $rect = $button.Current.BoundingRectangle
    $name = ([string]$button.Current.Name).Trim()
    if (-not $name -or $name -in @('Main menu', 'My Profile', 'Add Account', 'Add another account')) { continue }
    if ($rect.X -lt $window.X -or $rect.X -ge ($window.X + 330)) { continue }
    if ($rect.Y -lt ($window.Y + 75) -or $rect.Y -ge $profileY) { continue }
    if ($rect.Width -lt 140 -or $button.Current.ClassName -like '*IconButton*') { continue }
    $accounts += [ordered]@{ buttonName = $name }
  }
  if ($accounts.Count -eq 0) { [System.Windows.Forms.SendKeys]::SendWait('{ESC}') }
  return [ordered]@{ accounts = $accounts }
}

function Switch-Account($Process, [string]$ButtonName) {
  $root = Get-Root $Process
  $buttons = Get-Descendants $root ([System.Windows.Automation.ControlType]::Button)
  $target = $null
  foreach ($button in $buttons) {
    if ($button.Current.Name -eq $ButtonName) { $target = $button; break }
  }
  if (-not $target) { throw "Telegram account '$ButtonName' is no longer available in the account switcher." }
  if (-not (Invoke-Element $target)) { throw "Telegram account '$ButtonName' could not be selected." }
  Start-Sleep -Milliseconds 800
  return [ordered]@{ switched = $true; buttonName = $ButtonName }
}

function Open-Chat($Process, $Payload) {
  $root = Get-Root $Process
  if ([string]$Payload.chatType -eq 'Saved Messages' -or [string]$Payload.chatName -eq 'Saved Messages') {
    Open-MainMenu $root
    $root = Get-Root $Process
    $saved = Find-ByName $root ([System.Windows.Automation.ControlType]::Button) 'Saved Messages'
    if (-not (Invoke-Element $saved)) { throw 'Saved Messages could not be opened.' }
    Start-Sleep -Milliseconds 700
    return
  }

  $edits = Get-Descendants $root ([System.Windows.Automation.ControlType]::Edit)
  $search = $null
  foreach ($edit in $edits) {
    if ($edit.Current.Name -eq 'Search' -and $edit.Current.ClassName -like '*Inner*') { $search = $edit; break }
  }
  if (-not $search) {
    foreach ($edit in $edits) {
      if ($edit.Current.Name -eq 'Search') { $search = $edit; break }
    }
  }
  if (-not (Set-ElementValue $search ([string]$Payload.chatName))) {
    throw 'Telegram search could not be activated.'
  }
  Start-Sleep -Milliseconds 900

  $root = Get-Root $Process
  $list = Get-ChatsList $root
  if (-not $list) { throw 'Telegram search results are unavailable.' }
  $items = $list.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::ListItem
    )
  )
  $match = $null
  foreach ($item in $items) {
    $fields = Get-ChatFields $item
    if ([string]$fields.Name -eq [string]$Payload.chatName) { $match = $item; break }
  }
  if (-not $match) { throw "Telegram chat '$($Payload.chatName)' was not found in search results." }
  if (-not (Invoke-Element $match)) { throw "Telegram chat '$($Payload.chatName)' could not be opened." }
  Start-Sleep -Milliseconds 700
}

function Open-ExportSettings($Process) {
  $root = Get-Root $Process
  $menu = Find-ByName $root ([System.Windows.Automation.ControlType]::Button) 'Chat menu'
  if (-not (Invoke-Element $menu)) { throw 'Telegram Chat menu could not be opened.' }
  Start-Sleep -Milliseconds 350
  if (-not [LabSuiteTelegramAccessibility]::InvokePopupItem([uint32]$Process.Id, 'Export chat history')) {
    [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
    throw 'Telegram did not expose the Export chat history action.'
  }
  Start-Sleep -Milliseconds 700
  return [ordered]@{ opened = $true }
}

function Set-MaxSliderLimit($Root) {
  $sliders = Get-Descendants $Root ([System.Windows.Automation.ControlType]::Slider)
  if (-not $sliders -or $sliders.Count -eq 0) {
    $sliders = Get-Descendants $Root ([System.Windows.Automation.ControlType]::Thumb)
  }
  if (-not $sliders -or $sliders.Count -eq 0) {
    $sliders = Get-Descendants $Root ([System.Windows.Automation.ControlType]::ScrollBar)
  }

  if ($sliders -and $sliders.Count -gt 0) {
    foreach ($slider in $sliders) {
      try {
        $range = $null
        if ($slider.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$range)) {
          $range.SetValue($range.Current.Maximum)
          continue
        }
      } catch {}

      try {
        $rect = $slider.Current.BoundingRectangle
        if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
          [LabSuiteTelegramAccessibility]::Click(
            [int]($rect.X + $rect.Width - 4),
            [int]($rect.Y + ($rect.Height / 2))
          )
          Start-Sleep -Milliseconds 200
        }
      } catch {}
    }
  }

  # Also scan for Size limit text element and click far right of the slider line below it
  $texts = Get-Descendants $Root ([System.Windows.Automation.ControlType]::Text)
  $sizeText = $null
  foreach ($text in $texts) {
    if ($text.Current.Name -like '*Size limit:*' -or $text.Current.Name -like '*MB*') {
      $sizeText = $text
      break
    }
  }
  if ($sizeText) {
    $rect = $sizeText.Current.BoundingRectangle
    $dialogRect = $Root.Current.BoundingRectangle
    if ($dialogRect.Width -gt 0) {
      [LabSuiteTelegramAccessibility]::Click(
        [int]($dialogRect.X + $dialogRect.Width - 30),
        [int]($rect.Y + $rect.Height + 14)
      )
      Start-Sleep -Milliseconds 200
    }
  }
}

function Set-MediaSelection($Root, [bool]$Enabled) {
  $mediaNames = @('Photos', 'Videos', 'Voice messages', 'Video messages', 'Stickers', 'GIFs', 'Files')
  foreach ($name in $mediaNames) {
    $box = Find-ByName $Root ([System.Windows.Automation.ControlType]::CheckBox) $name
    if (-not $box) { continue }
    $toggle = $null
    if ($box.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)) {
      $isOn = $toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On
      if ($isOn -ne $Enabled) { $toggle.Toggle() }
    }
  }
  if ($Enabled) {
    Set-MaxSliderLimit $Root
  }
}

function Open-JsonFormat($Root) {
  $settings = Get-ExportSettingsInfo $Root
  $formatLabel = $settings.formatElement
  if (-not $formatLabel) { throw 'Telegram export format control was not found.' }
  if (Test-JsonExportFormat ([string]$settings.format)) { return $false }
  $process = Get-TelegramProcess
  $shell = New-Object -ComObject WScript.Shell
  $shell.AppActivate($process.Id) | Out-Null
  Start-Sleep -Milliseconds 150
  $rect = $formatLabel.Current.BoundingRectangle
  [LabSuiteTelegramAccessibility]::Click(
    [int]($rect.X + [Math]::Min(60, $rect.Width / 3)),
    [int]($rect.Y + ($rect.Height / 2))
  )
  Start-Sleep -Milliseconds 500
  return $true
}

function Select-JsonFormat($Process) {
  Start-Sleep -Milliseconds 400
  $root = Get-Root $Process
  $jsonOption = $null

  # Telegram's official format dialog contains radio rows in this order:
  # HTML, JSON, HTML and JSON. Prefer the explicitly named JSON-only row.
  $radioButtons = @(Get-Descendants $root ([System.Windows.Automation.ControlType]::RadioButton)) |
    Where-Object { -not $_.Current.IsOffscreen } |
    Sort-Object { $_.Current.BoundingRectangle.Y }
  foreach ($radio in $radioButtons) {
    $text = (@(Get-ElementTextCandidates $radio) -join ' ')
    if ($text -match '(?i)\bJSON\b' -and $text -notmatch '(?i)\bHTML\b') {
      $jsonOption = $radio
      break
    }
  }

  if (-not $jsonOption) {
    foreach ($entry in @(Get-DialogTextEntries $root)) {
      if ($entry.Text -match '(?i)\bJSON\b' -and $entry.Text -notmatch '(?i)\bHTML\b') {
        $jsonOption = $entry.Element
        break
      }
    }
  }

  # Qt can omit radio names from UIA while retaining their ordering.
  if (-not $jsonOption -and $radioButtons.Count -ge 2) {
    $jsonOption = $radioButtons[1]
  }
  if (-not $jsonOption) { throw 'Telegram JSON-only export option was not found.' }

  if (-not (Invoke-Element $jsonOption)) {
    $rect = $jsonOption.Current.BoundingRectangle
    if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
      [LabSuiteTelegramAccessibility]::Click(
        [int]($rect.X + ($rect.Width / 2)),
        [int]($rect.Y + ($rect.Height / 2))
      )
      Start-Sleep -Milliseconds 300
    }
  }

  $root = Get-Root $Process
  $save = Find-ByName $root ([System.Windows.Automation.ControlType]::Button) 'Save'
  if (-not $save) {
    $save = Find-ByName $root ([System.Windows.Automation.ControlType]::Button) 'OK'
  }
  if ($save) {
    if (-not (Invoke-Element $save)) {
      $saveRect = $save.Current.BoundingRectangle
      [LabSuiteTelegramAccessibility]::Click(
        [int]($saveRect.X + ($saveRect.Width / 2)),
        [int]($saveRect.Y + ($saveRect.Height / 2))
      )
    }
  } else {
    throw 'Telegram export format Save button was not found.'
  }
  Start-Sleep -Milliseconds 500
  $settings = Get-ExportSettingsInfo (Get-Root $Process)
  if (-not (Test-JsonExportFormat ([string]$settings.format))) {
    $detected = if ($settings.format) { [string]$settings.format } else { 'unknown' }
    throw "Telegram did not switch the export format to JSON (detected: $detected)."
  }
  return [ordered]@{ selected = $true; format = [string]$settings.format }
}

function Open-FromDate($Process, $Payload) {
  if (-not $Payload.checkpointDate) {
    return [ordered]@{ needsDateSelection = $false }
  }
  $checkpoint = [DateTime]::Parse([string]$Payload.checkpointDate).ToLocalTime().Date
  $target = $checkpoint.AddDays(-1)
  $today = [DateTime]::Now.Date
  if ($target -gt $today) { $target = $today }

  $root = Get-Root $Process
  $labels = Get-Descendants $root ([System.Windows.Automation.ControlType]::Text)
  $dateLabel = $null
  foreach ($label in $labels) {
    if ($label.Current.Name -like 'From:*') { $dateLabel = $label; break }
  }
  if (-not $dateLabel) { throw 'Telegram export date control was not found.' }

  $shell = New-Object -ComObject WScript.Shell
  $shell.AppActivate($Process.Id) | Out-Null
  Start-Sleep -Milliseconds 150
  $rect = $dateLabel.Current.BoundingRectangle
  [LabSuiteTelegramAccessibility]::Click(
    [int]($rect.X + [Math]::Min(100, $rect.Width / 2)),
    [int]($rect.Y + ($rect.Height / 2))
  )
  Start-Sleep -Milliseconds 500
  return [ordered]@{
    needsDateSelection = $true
    targetDate = $target.ToString('yyyy-MM-dd')
  }
}

function Select-FromDate($Process, $Payload) {
  $target = [DateTime]::ParseExact([string]$Payload.targetDate, 'yyyy-MM-dd', $null)
  $root = Get-Root $Process
  $calendar = $null
  $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($element in $elements) {
    if ($element.Current.ClassName -eq 'class Ui::CalendarBox') { $calendar = $element; break }
  }
  if (-not $calendar) { throw 'Telegram export calendar did not open.' }
  $buttons = Get-Descendants $root ([System.Windows.Automation.ControlType]::Button)
  $closeRect = $null
  foreach ($button in $buttons) {
    if ($button.Current.Name -eq 'Close' -and $button.Current.ClassName -like '*RoundButton*') {
      $closeRect = $button.Current.BoundingRectangle
      break
    }
  }
  if (-not $closeRect) { throw 'Telegram export calendar Close button was not found.' }

  $shell = New-Object -ComObject WScript.Shell
  $shell.AppActivate($Process.Id) | Out-Null
  Start-Sleep -Milliseconds 100
  $rect = $calendar.Current.BoundingRectangle
  $currentMonth = [DateTime]::Now.Year * 12 + [DateTime]::Now.Month
  $targetMonth = $target.Year * 12 + $target.Month
  $monthDelta = $targetMonth - $currentMonth
  $steps = [Math]::Abs($monthDelta)
  for ($index = 0; $index -lt $steps; $index++) {
    $arrowX = if ($monthDelta -lt 0) { $rect.X + 240 } else { $rect.X + 288 }
    [LabSuiteTelegramAccessibility]::Click([int]$arrowX, [int]($rect.Y + 32))
    Start-Sleep -Milliseconds 120
  }

  $firstOfMonth = [DateTime]::new($target.Year, $target.Month, 1)
  $dayIndex = [int]$firstOfMonth.DayOfWeek + $target.Day - 1
  $column = $dayIndex % 7
  $row = [Math]::Floor($dayIndex / 7)
  $dayX = $rect.X + (($column + 0.5) * ($rect.Width / 7))
  $dayY = $rect.Y + 115 + ($row * 38)
  [LabSuiteTelegramAccessibility]::Click([int]$dayX, [int]$dayY)
  Start-Sleep -Milliseconds 200
  [LabSuiteTelegramAccessibility]::Click(
    [int]($closeRect.X + ($closeRect.Width / 2)),
    [int]($closeRect.Y + ($closeRect.Height / 2))
  )
  Start-Sleep -Milliseconds 400
  return [ordered]@{ selected = $true; targetDate = $target.ToString('yyyy-MM-dd') }
}

function Get-WindowsDownloadsPath {
  $userProfile = [Environment]::GetFolderPath('UserProfile')
  $fallback = Join-Path $userProfile 'Downloads'
  $downloadsGuid = '{374DE290-123F-4565-9164-39C4925E467B}'
  foreach ($registryPath in @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders',
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders'
  )) {
    try {
      $properties = Get-ItemProperty -LiteralPath $registryPath
      $property = $properties.PSObject.Properties[$downloadsGuid]
      if ($property -and $property.Value) {
        $expanded = [Environment]::ExpandEnvironmentVariables([string]$property.Value)
        if ([System.IO.Path]::IsPathRooted($expanded)) {
          return [System.IO.Path]::GetFullPath($expanded)
        }
      }
    } catch {}
  }
  return $fallback
}

function Resolve-ExportRoot($Process) {
  $root = Get-Root $Process
  $settings = Get-ExportSettingsInfo $root
  $configured = [string]$settings.path
  $userProfile = [Environment]::GetFolderPath('UserProfile')
  $downloads = Get-WindowsDownloadsPath
  if ($configured) {
    $configured = [Environment]::ExpandEnvironmentVariables($configured.Trim().Trim('"'))
    if ($configured -match '(?i)^(?:Temporary|Temp)(?:\s+folder)?$') {
      return [System.IO.Path]::GetTempPath()
    }
    if ($configured -match '(?i)^Downloads(?:[\\/](.*))?$') {
      $tail = [string]$Matches[1]
      if ($tail) { return (Join-Path $downloads $tail) }
      return $downloads
    }
    if ($configured -match '^~[\\/](.*)$') {
      return (Join-Path $userProfile ([string]$Matches[1]))
    }
    if ([System.IO.Path]::IsPathRooted($configured)) {
      return [System.IO.Path]::GetFullPath($configured)
    }
    return (Join-Path $userProfile $configured)
  }
  return (Join-Path $downloads 'Telegram Desktop')
}

function Get-ExportSearchRoots([string]$ExportRoot) {
  $userProfile = [Environment]::GetFolderPath('UserProfile')
  $downloadRoots = @(
    (Get-WindowsDownloadsPath),
    (Join-Path $userProfile 'Downloads')
  )
  foreach ($oneDriveRoot in @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial)) {
    if ($oneDriveRoot) { $downloadRoots += (Join-Path $oneDriveRoot 'Downloads') }
  }

  $candidatePaths = @($ExportRoot)
  foreach ($downloads in $downloadRoots) {
    $candidatePaths += $downloads
    $candidatePaths += (Join-Path $downloads 'Telegram Desktop')
  }
  $candidatePaths += [System.IO.Path]::GetTempPath()
  if ($env:LOCALAPPDATA) { $candidatePaths += (Join-Path $env:LOCALAPPDATA 'Temp') }
  $seen = @{}
  $roots = @()
  foreach ($candidatePath in $candidatePaths) {
    if (-not $candidatePath) { continue }
    try {
      $resolved = [System.IO.Path]::GetFullPath([string]$candidatePath)
    } catch {
      continue
    }
    if ($seen.ContainsKey($resolved)) { continue }
    $seen[$resolved] = $true
    $roots += $resolved
  }
  return $roots
}

function Get-ResultFiles([string[]]$RootPaths) {
  $files = @{}
  foreach ($rootPath in $RootPaths) {
    if (-not $rootPath -or -not (Test-Path -LiteralPath $rootPath)) { continue }
    Get-ChildItem -LiteralPath $rootPath -Filter result.json -File -Recurse -ErrorAction SilentlyContinue |
      ForEach-Object { $files[$_.FullName] = $_ }
  }
  return @($files.Values)
}

function Get-ResultSnapshot([string[]]$RootPaths) {
  $snapshot = [ordered]@{}
  foreach ($file in @(Get-ResultFiles $RootPaths)) {
    $snapshot[$file.FullName] = $file.LastWriteTimeUtc.Ticks
  }
  return $snapshot
}

function Test-ExportCompletionDialog($Process) {
  try {
    $root = Get-Root $Process
    $elements = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($element in $elements) {
      $name = ([string]$element.Current.Name).Trim()
      if ($name -match '(?i)\b(?:Data export completed|Your data was successfully exported|Show my data)\b') {
        return $true
      }
    }
  } catch {}
  return $false
}

function Get-RevealedExportResult([datetime]$StartedAt) {
  try {
    $shell = New-Object -ComObject Shell.Application
    $paths = @()
    foreach ($window in @($shell.Windows())) {
      try {
        if ([System.IO.Path]::GetFileName([string]$window.FullName) -ine 'explorer.exe') { continue }
        $selected = $window.Document.SelectedItems()
        for ($index = 0; $index -lt $selected.Count; $index++) {
          $paths += [string]$selected.Item($index).Path
        }
      } catch {}
    }

    foreach ($candidatePath in @($paths | Where-Object { $_ } | Select-Object -Unique)) {
      $revealedHtml = $null
      if (Test-Path -LiteralPath $candidatePath -PathType Leaf) {
        $file = Get-Item -LiteralPath $candidatePath -ErrorAction SilentlyContinue
        if (-not $file -or $file.LastWriteTimeUtc -lt $StartedAt.AddSeconds(-2)) { continue }
        if ($file.Name -ieq 'result.json') {
          return [ordered]@{ resultPath = $file.FullName; revealedPath = $file.FullName }
        }
        if ($file.Extension -ieq '.html') {
          $revealedHtml = $file.FullName
        }
        $candidatePath = $file.DirectoryName
      }
      if (-not (Test-Path -LiteralPath $candidatePath -PathType Container)) { continue }
      $result = Get-ChildItem -LiteralPath $candidatePath -Filter result.json -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTimeUtc -ge $StartedAt.AddSeconds(-2) } |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
      if ($result) {
        return [ordered]@{ resultPath = $result.FullName; revealedPath = $candidatePath }
      }
      if ($revealedHtml) {
        return [ordered]@{ resultPath = $null; revealedPath = $revealedHtml }
      }
      $html = Get-ChildItem -LiteralPath $candidatePath -Filter *.html -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTimeUtc -ge $StartedAt.AddSeconds(-2) } |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
      if ($html) {
        return [ordered]@{ resultPath = $null; revealedPath = $html.FullName }
      }
    }
  } catch {}
  return [ordered]@{ resultPath = $null; revealedPath = $null }
}

function Reveal-CompletedExportResult($Process, [datetime]$StartedAt) {
  try {
    $root = Get-Root $Process
    $showButton = Find-ByName $root ([System.Windows.Automation.ControlType]::Button) 'Show my data'
    if (-not $showButton) { return [ordered]@{ resultPath = $null; revealedPath = $null } }
    if (-not (Invoke-Element $showButton)) {
      $rect = $showButton.Current.BoundingRectangle
      [LabSuiteTelegramAccessibility]::Click(
        [int]($rect.X + ($rect.Width / 2)),
        [int]($rect.Y + ($rect.Height / 2))
      )
    }
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
      Start-Sleep -Milliseconds 500
      $revealed = Get-RevealedExportResult $StartedAt
      if ($revealed.resultPath -or $revealed.revealedPath) { return $revealed }
    }
  } catch {}
  return [ordered]@{ resultPath = $null; revealedPath = $null }
}

function Dismiss-ExportCompletionDialog($Process, [int]$WaitMilliseconds = 0) {
  try {
    $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(0, $WaitMilliseconds))
    while ($true) {
      if (Test-ExportCompletionDialog $Process) {
        $shell = New-Object -ComObject WScript.Shell
        $shell.AppActivate($Process.Id) | Out-Null
        Start-Sleep -Milliseconds 100
        [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
        Start-Sleep -Milliseconds 350
        if (-not (Test-ExportCompletionDialog $Process)) { return $true }

        $root = Get-Root $Process
        foreach ($buttonName in @('Close', 'Done', 'OK')) {
          $button = Find-ByName $root ([System.Windows.Automation.ControlType]::Button) $buttonName
          if (Invoke-Element $button) {
            Start-Sleep -Milliseconds 250
            if (-not (Test-ExportCompletionDialog $Process)) { return $true }
          }
        }
        return $false
      }
      if ([DateTime]::UtcNow -ge $deadline) { return $false }
      Start-Sleep -Milliseconds 250
    }
  } catch {
    return $false
  }
}

function Wait-ForResult($Process, [string[]]$RootPaths, $Before, [datetime]$StartedAt, [int]$TimeoutSeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $stablePath = $null
  $stableLength = -1
  $stablePasses = 0
  $completionDetectedAt = $null
  $revealAttempted = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 1000
    $completionVisible = Test-ExportCompletionDialog $Process
    if ($completionVisible -and -not $completionDetectedAt) {
      $completionDetectedAt = [DateTime]::UtcNow
    }
    $candidates = @(Get-ResultFiles $RootPaths) |
      Where-Object {
        -not $Before.Contains($_.FullName) -or
        $Before[$_.FullName] -ne $_.LastWriteTimeUtc.Ticks -or
        $_.LastWriteTimeUtc -ge $StartedAt.AddSeconds(-2)
      } |
      Sort-Object LastWriteTimeUtc -Descending
    $candidate = $candidates | Select-Object -First 1
    if (-not $candidate) {
      if ($completionDetectedAt -and -not $revealAttempted -and [DateTime]::UtcNow -ge $completionDetectedAt.AddSeconds(5)) {
        $revealAttempted = $true
        $revealed = Reveal-CompletedExportResult $Process $StartedAt
        if ($revealed.resultPath) { return [string]$revealed.resultPath }
        if ($revealed.revealedPath -and [System.IO.Path]::GetExtension([string]$revealed.revealedPath) -ieq '.html') {
          throw "Telegram completed an HTML export instead of the required JSON export: $($revealed.revealedPath)"
        }
      }
      if ($completionDetectedAt -and [DateTime]::UtcNow -ge $completionDetectedAt.AddSeconds(15)) {
        throw "Telegram reported that the export completed, but result.json was not found in: $($RootPaths -join ', ')."
      }
      continue
    }
    if ($stablePath -eq $candidate.FullName -and $stableLength -eq $candidate.Length) {
      $stablePasses++
    } else {
      $stablePath = $candidate.FullName
      $stableLength = $candidate.Length
      $stablePasses = 0
    }
    if ($stablePasses -ge 2 -and $candidate.Length -gt 0) { return $candidate.FullName }
  }
  throw "Telegram export did not finish within $TimeoutSeconds seconds."
}

function Start-Export($Process, $Payload) {
  $exportRoot = Resolve-ExportRoot $Process
  $searchRoots = @(Get-ExportSearchRoots $exportRoot)
  $before = Get-ResultSnapshot $searchRoots
  $startedAt = [DateTime]::UtcNow
  $root = Get-Root $Process
  $exportButton = Find-ByName $root ([System.Windows.Automation.ControlType]::Button) 'Export'
  if (-not (Invoke-Element $exportButton)) { throw 'Telegram Export button could not be invoked.' }

  $timeout = if ($Payload.timeoutSeconds) { [int]$Payload.timeoutSeconds } else { 1800 }
  $resultPath = $null
  try {
    $resultPath = Wait-ForResult $Process $searchRoots $before $startedAt $timeout
  } finally {
    Dismiss-ExportCompletionDialog $Process 3000 | Out-Null
  }
  return [ordered]@{
    resultPath = $resultPath
    exportRoot = $exportRoot
    startedAt = $startedAt.ToString('o')
    fromDateApplied = [bool]$Payload.dateApplied
  }
}

function Write-LabSuiteResult($Value, [int]$Depth = 8) {
  $json = $Value | ConvertTo-Json -Depth $Depth -Compress
  if ($ResultPath) {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($ResultPath, $json, $utf8NoBom)
  }
  Write-Output $json
}

$payload = Get-Content -LiteralPath $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
$process = Get-TelegramProcess

if ($Action -eq 'foreground') {
  $cursor = [LabSuiteTelegramAccessibility]::CursorPosition().Split(',')
  Write-LabSuiteResult ([ordered]@{
    handle = [LabSuiteTelegramAccessibility]::ForegroundHandle().ToString()
    cursorX = [int]$cursor[0]
    cursorY = [int]$cursor[1]
  })
  exit 0
}

if ($Action -eq 'restore-foreground') {
  $restored = [LabSuiteTelegramAccessibility]::RestoreWindow(
    [long]$payload.handle,
    [int]$payload.cursorX,
    [int]$payload.cursorY
  )
  Write-LabSuiteResult ([ordered]@{ restored = [bool]$restored })
  exit 0
}

if ($Action -eq 'scan') {
  $maxScrolls = if ($payload.maxScrolls -ne $null) { [int]$payload.maxScrolls } else { 40 }
  $account = Scan-CurrentAccount $process $maxScrolls
  Write-LabSuiteResult ([ordered]@{
    accounts = @($account)
    scannedAt = [DateTime]::UtcNow.ToString('o')
  }) 8
  exit 0
}

if ($Action -eq 'open-account-switcher') {
  Write-LabSuiteResult (Open-AccountSwitcher $process) 5
  exit 0
}

if ($Action -eq 'list-account-switcher') {
  Write-LabSuiteResult (Get-AccountSwitcherButtons $process) 8
  exit 0
}

if ($Action -eq 'switch-account') {
  Write-LabSuiteResult (Switch-Account $process ([string]$payload.buttonName)) 5
  exit 0
}

if ($Action -eq 'dismiss') {
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  Write-LabSuiteResult ([ordered]@{ dismissed = $true })
  exit 0
}

if ($Action -eq 'open-export') {
  Open-Chat $process $payload
  Write-LabSuiteResult (Open-ExportSettings $process) 5
  exit 0
}

if ($Action -eq 'open-format') {
  $root = Get-Root $process
  $title = Find-ByName $root ([System.Windows.Automation.ControlType]::Text) 'Chat export settings'
  if (-not $title) { throw 'Telegram Chat export settings are not open.' }
  Set-MediaSelection $root ([bool]$payload.includeMedia)
  $opened = Open-JsonFormat $root
  Write-LabSuiteResult ([ordered]@{ needsJsonSelection = [bool]$opened })
  exit 0
}

if ($Action -eq 'select-json') {
  Write-LabSuiteResult (Select-JsonFormat $process) 5
  exit 0
}

if ($Action -eq 'open-date') {
  Write-LabSuiteResult (Open-FromDate $process $payload) 5
  exit 0
}

if ($Action -eq 'select-date') {
  Write-LabSuiteResult (Select-FromDate $process $payload) 5
  exit 0
}

if ($Action -eq 'start-export') {
  Write-LabSuiteResult (Start-Export $process $payload) 8
  exit 0
}
