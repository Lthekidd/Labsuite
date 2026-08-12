import { Cpu } from '@phosphor-icons/react/Cpu';
import { CurrencyBtc } from '@phosphor-icons/react/CurrencyBtc';
import { DesktopTower } from '@phosphor-icons/react/DesktopTower';
import { GearSix } from '@phosphor-icons/react/GearSix';
import { HardDrives } from '@phosphor-icons/react/HardDrives';
import { Kanban } from '@phosphor-icons/react/Kanban';
import { Notebook } from '@phosphor-icons/react/Notebook';
import { Package } from '@phosphor-icons/react/Package';
import { ShieldCheck } from '@phosphor-icons/react/ShieldCheck';
import { SquaresFour } from '@phosphor-icons/react/SquaresFour';
import { Table } from '@phosphor-icons/react/Table';
import { TelegramLogo } from '@phosphor-icons/react/TelegramLogo';
import { Power } from '@phosphor-icons/react/Power';
import { MusicNotes } from '@phosphor-icons/react/MusicNotes';
import LabShotMark from './LabShotMark';
import LabMediaMark from './LabMediaMark';

const APP_ICONS = {
  hub: SquaresFour,
  backup: ShieldCheck,
  telegram: TelegramLogo,
  crypto: CurrencyBtc,
  notebook: Notebook,
  sheets: Table,
  lan: HardDrives,
  'vm-protect': DesktopTower,
  todo: Kanban,
  hwmonitor: Cpu,
  labmedia: MusicNotes,
  settings: GearSix,
  device: DesktopTower,
  package: Package,
  wol: Power
};

export default function AppIcon({
  appId,
  size = 18,
  weight = 'regular',
  color = 'currentColor',
  ...props
}) {
  if (appId === 'labshot') {
    return <LabShotMark size={size} className={props.className || ''} style={props.style} />;
  }
  if (appId === 'labmedia') {
    return <LabMediaMark size={size} className={props.className || ''} style={props.style} color={color} />;
  }

  const Icon = APP_ICONS[appId] || Package;
  return (
    <Icon
      size={size}
      weight={weight}
      color={color}
      aria-hidden="true"
      {...props}
    />
  );
}
