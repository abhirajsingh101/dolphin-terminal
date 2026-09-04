import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  Brain,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  CirclePause,
  ExternalLink,
  FolderGit2,
  History,
  LoaderCircle,
  Maximize2,
  Mic,
  Minimize2,
  MoreHorizontal,
  MousePointer2,
  OctagonX,
  Paperclip,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Settings2,
  Square,
  TerminalSquare,
  TextSelect,
  Timer,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import type { TerminalTarget } from '@dolphin-terminal/protocol';

export interface TerminalIconRegistry {
  ArrowDown: LucideIcon;
  ArrowLeft: LucideIcon;
  ArrowRight: LucideIcon;
  ArrowUp: LucideIcon;
  Bot: LucideIcon;
  Brain: LucideIcon;
  Check: LucideIcon;
  CheckCircle2: LucideIcon;
  ChevronsUpDown: LucideIcon;
  CirclePause: LucideIcon;
  ExternalLink: LucideIcon;
  FolderGit2: LucideIcon;
  History: LucideIcon;
  LoaderCircle: LucideIcon;
  Maximize2: LucideIcon;
  Mic: LucideIcon;
  Minimize2: LucideIcon;
  MoreHorizontal: LucideIcon;
  MousePointer2: LucideIcon;
  OctagonX: LucideIcon;
  Paperclip: LucideIcon;
  Pencil: LucideIcon;
  Plus: LucideIcon;
  Power: LucideIcon;
  RefreshCw: LucideIcon;
  Settings2: LucideIcon;
  Square: LucideIcon;
  TerminalSquare: LucideIcon;
  TextSelect: LucideIcon;
  Timer: LucideIcon;
  TriangleAlert: LucideIcon;
  X: LucideIcon;
}

export interface TerminalRuntimeSlots {
  dockLeading?: ReactNode;
  dockTrailing?: ReactNode;
  toolbarLeading?: (target: TerminalTarget) => ReactNode;
  toolbarTrailing?: (target: TerminalTarget) => ReactNode;
}

export const defaultTerminalIcons: TerminalIconRegistry = {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  Brain,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  CirclePause,
  ExternalLink,
  FolderGit2,
  History,
  LoaderCircle,
  Maximize2,
  Mic,
  Minimize2,
  MoreHorizontal,
  MousePointer2,
  OctagonX,
  Paperclip,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Settings2,
  Square,
  TerminalSquare,
  TextSelect,
  Timer,
  TriangleAlert,
  X,
};
