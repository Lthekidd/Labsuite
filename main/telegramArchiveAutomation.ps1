param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('foreground', 'restore-foreground', 'scan', 'open-account-switcher', 'list-account-switcher', 'switch-account', 'dismiss', 'open-export', 'open-format', 'select-json', 'open-date', 'select-date', 'start-export')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$PayloadPath
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
    $candidates = @(
      (Join-Path $env:APPDATA 'Telegram Desktop\Telegram.exe'),
      (Join-Path $env:LOCALAPPDATA 'Telegram Desktop\Telegram.exe')
    )
    $executable = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
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
}

function Open-JsonFormat($Root) {
  $labels = Get-Descendants $Root ([System.Windows.Automation.ControlType]::Text)
  $formatLabel = $null
  foreach ($label in $labels) {
    if ($label.Current.Name -like 'Format:*') { $formatLabel = $label; break }
  }
  if (-not $formatLabel) { throw 'Telegram export format control was not found.' }
  if ($formatLabel.Current.Name -like 'Format: JSON*') { return $false }
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
  $root = Get-Root $Process
  $jsonOption = $null
  $radios = Get-Descendants $root ([System.Windows.Automation.ControlType]::RadioButton)
  foreach ($radio in $radios) {
    if ($radio.Current.Name -like '*JSON*') { $jsonOption = $radio; break }
  }
  if (-not $jsonOption) { throw 'Telegram JSON export option was not found.' }
  if (-not (Invoke-Element $jsonOption)) { throw 'Telegram JSON export option could not be selected.' }
  $root = Get-Root $Process
  $save = Find-ByName $root ([System.Windows.Automation.ControlType]::Button) 'Save'
  if (-not (Invoke-Element $save)) { throw 'Telegram export format could not be saved.' }
  Start-Sleep -Milliseconds 500
  return [ordered]@{ selected = $true }
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

function Resolve-ExportRoot($Process) {
  $root = Get-Root $Process
  $labels = Get-Descendants $root ([System.Windows.Automation.ControlType]::Text)
  $pathText = ''
  foreach ($label in $labels) {
    if ($label.Current.Name -like 'Format:*Path:*') { $pathText = [string]$label.Current.Name; break }
  }
  $downloads = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads'
  if ($pathText -match 'Path:\s*(.+)$') {
    $configured = $Matches[1].Trim()
    if ($configured -match '^Downloads[\\/]*(.*)$') {
      $tail = $Matches[1]
      if ($tail) { return (Join-Path $downloads $tail) }
      return $downloads
    }
    if ([System.IO.Path]::IsPathRooted($configured)) { return $configured }
  }
  return (Join-Path $downloads 'Telegram Desktop')
}

function Get-ResultSnapshot([string]$RootPath) {
  $snapshot = [ordered]@{}
  if (Test-Path -LiteralPath $RootPath) {
    Get-ChildItem -LiteralPath $RootPath -Filter result.json -File -Recurse -ErrorAction SilentlyContinue |
      ForEach-Object { $snapshot[$_.FullName] = $_.LastWriteTimeUtc.Ticks }
  }
  return $snapshot
}

function Wait-ForResult([string]$RootPath, $Before, [datetime]$StartedAt, [int]$TimeoutSeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $stablePath = $null
  $stableLength = -1
  $stablePasses = 0
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 1000
    if (-not (Test-Path -LiteralPath $RootPath)) { continue }
    $candidates = Get-ChildItem -LiteralPath $RootPath -Filter result.json -File -Recurse -ErrorAction SilentlyContinue |
      Where-Object {
        -not $Before.Contains($_.FullName) -or
        $Before[$_.FullName] -ne $_.LastWriteTimeUtc.Ticks -or
        $_.LastWriteTimeUtc -ge $StartedAt.AddSeconds(-2)
      } |
      Sort-Object LastWriteTimeUtc -Descending
    $candidate = $candidates | Select-Object -First 1
    if (-not $candidate) { continue }
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
  $before = Get-ResultSnapshot $exportRoot
  $startedAt = [DateTime]::UtcNow
  $root = Get-Root $Process
  $exportButton = Find-ByName $root ([System.Windows.Automation.ControlType]::Button) 'Export'
  if (-not (Invoke-Element $exportButton)) { throw 'Telegram Export button could not be invoked.' }

  $timeout = if ($Payload.timeoutSeconds) { [int]$Payload.timeoutSeconds } else { 1800 }
  $resultPath = Wait-ForResult $exportRoot $before $startedAt $timeout
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  return [ordered]@{
    resultPath = $resultPath
    exportRoot = $exportRoot
    startedAt = $startedAt.ToString('o')
    fromDateApplied = [bool]$Payload.dateApplied
  }
}

$payload = Get-Content -LiteralPath $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
$process = Get-TelegramProcess

if ($Action -eq 'foreground') {
  $cursor = [LabSuiteTelegramAccessibility]::CursorPosition().Split(',')
  [ordered]@{
    handle = [LabSuiteTelegramAccessibility]::ForegroundHandle().ToString()
    cursorX = [int]$cursor[0]
    cursorY = [int]$cursor[1]
  } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'restore-foreground') {
  $restored = [LabSuiteTelegramAccessibility]::RestoreWindow(
    [long]$payload.handle,
    [int]$payload.cursorX,
    [int]$payload.cursorY
  )
  [ordered]@{ restored = [bool]$restored } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'scan') {
  $maxScrolls = if ($payload.maxScrolls -ne $null) { [int]$payload.maxScrolls } else { 40 }
  $account = Scan-CurrentAccount $process $maxScrolls
  [ordered]@{
    accounts = @($account)
    scannedAt = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json -Depth 8 -Compress
  exit 0
}

if ($Action -eq 'open-account-switcher') {
  Open-AccountSwitcher $process | ConvertTo-Json -Depth 5 -Compress
  exit 0
}

if ($Action -eq 'list-account-switcher') {
  Get-AccountSwitcherButtons $process | ConvertTo-Json -Depth 8 -Compress
  exit 0
}

if ($Action -eq 'switch-account') {
  Switch-Account $process ([string]$payload.buttonName) | ConvertTo-Json -Depth 5 -Compress
  exit 0
}

if ($Action -eq 'dismiss') {
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  [ordered]@{ dismissed = $true } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'open-export') {
  Open-Chat $process $payload
  Open-ExportSettings $process | ConvertTo-Json -Depth 5 -Compress
  exit 0
}

if ($Action -eq 'open-format') {
  $root = Get-Root $process
  $title = Find-ByName $root ([System.Windows.Automation.ControlType]::Text) 'Chat export settings'
  if (-not $title) { throw 'Telegram Chat export settings are not open.' }
  Set-MediaSelection $root ([bool]$payload.includeMedia)
  $opened = Open-JsonFormat $root
  [ordered]@{ needsJsonSelection = [bool]$opened } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'select-json') {
  Select-JsonFormat $process | ConvertTo-Json -Depth 5 -Compress
  exit 0
}

if ($Action -eq 'open-date') {
  Open-FromDate $process $payload | ConvertTo-Json -Depth 5 -Compress
  exit 0
}

if ($Action -eq 'select-date') {
  Select-FromDate $process $payload | ConvertTo-Json -Depth 5 -Compress
  exit 0
}

if ($Action -eq 'start-export') {
  Start-Export $process $payload | ConvertTo-Json -Depth 8 -Compress
  exit 0
}
