import type { SVGProps } from "react";
type IconProps = SVGProps<SVGSVGElement>;
const defaults: IconProps = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
function Icon({ children, ...props }: IconProps & { children: React.ReactNode }) { return <svg {...defaults} {...props}>{children}</svg>; }

export function PackageIcon(props: IconProps) { return <Icon {...props}><path d="M16.5 9.4l-9-5.19M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></Icon>; }
export function UsersIcon(props: IconProps) { return <Icon {...props}><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" /></Icon>; }
export function PlusCircleIcon(props: IconProps) { return <Icon {...props}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" /></Icon>; }
export function DollarIcon(props: IconProps) { return <Icon {...props}><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" /></Icon>; }
export function BarChartIcon(props: IconProps) { return <Icon {...props}><line x1="12" y1="20" x2="12" y2="10" /><line x1="18" y1="20" x2="18" y2="4" /><line x1="6" y1="20" x2="6" y2="16" /></Icon>; }
export function SearchIcon(props: IconProps) { return <Icon {...props}><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></Icon>; }
export function ScanIcon(props: IconProps) { return <Icon {...props}><path d="M23 6V1h-5M1 6V1h5M23 18v5h-5M1 18v5h5" /><line x1="1" y1="12" x2="23" y2="12" /></Icon>; }
export function TrashIcon(props: IconProps) { return <Icon {...props}><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></Icon>; }
export function EditIcon(props: IconProps) { return <Icon {...props}><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></Icon>; }
export function DownloadIcon(props: IconProps) { return <Icon {...props}><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></Icon>; }
export function FilterIcon(props: IconProps) { return <Icon {...props}><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></Icon>; }
export function AlertIcon(props: IconProps) { return <Icon {...props}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></Icon>; }
export function ChevronRightIcon(props: IconProps) { return <Icon {...props}><polyline points="9 18 15 12 9 6" /></Icon>; }
export function LockIcon(props: IconProps) { return <Icon {...props}><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></Icon>; }