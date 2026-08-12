export const landingBackgroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 720" role="img" aria-label="Abstract stack of published pages">
  <defs>
    <pattern id="grain" width="18" height="18" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="3" r="1" fill="#20211e" opacity=".08"/>
      <circle cx="14" cy="10" r=".8" fill="#20211e" opacity=".07"/>
      <path d="M5 15h5" stroke="#20211e" stroke-width=".7" opacity=".06"/>
    </pattern>
    <filter id="rough" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency=".025" numOctaves="2" seed="11" result="noise"/>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="3"/>
    </filter>
  </defs>
  <rect width="760" height="720" rx="28" fill="#d8b64b"/>
  <rect width="760" height="720" rx="28" fill="url(#grain)"/>
  <path d="M-20 530C134 416 255 606 421 469c105-86 211-70 359-13v284H-20Z" fill="#a43f24" filter="url(#rough)"/>
  <circle cx="632" cy="114" r="80" fill="#f3f0e8" stroke="#20211e" stroke-width="6"/>
  <path d="m607 114 17 18 35-43" fill="none" stroke="#a43f24" stroke-linecap="square" stroke-width="11"/>
  <g transform="rotate(-8 361 351)" filter="url(#rough)">
    <rect x="136" y="106" width="452" height="484" rx="8" fill="#20211e" opacity=".18" transform="translate(20 24)"/>
    <rect x="136" y="106" width="452" height="484" rx="8" fill="#fbfaf6" stroke="#20211e" stroke-width="6"/>
    <path d="M136 184h452" stroke="#20211e" stroke-width="6"/>
    <circle cx="174" cy="145" r="9" fill="#a43f24"/>
    <circle cx="207" cy="145" r="9" fill="#d8b64b" stroke="#20211e" stroke-width="3"/>
    <circle cx="240" cy="145" r="9" fill="#315a3a"/>
    <path d="M184 246h260M184 290h350M184 334h298" stroke="#20211e" stroke-linecap="square" stroke-width="16"/>
    <rect x="184" y="395" width="278" height="126" fill="#a43f24"/>
    <path d="m487 427 55 47-55 47" fill="none" stroke="#20211e" stroke-linecap="square" stroke-linejoin="miter" stroke-width="16"/>
  </g>
  <path d="M75 81c28-33 60-48 98-45M52 121c42-22 81-28 117-17" fill="none" stroke="#20211e" stroke-linecap="square" stroke-width="8"/>
  <path d="m648 598 28-58 28 58 62 9-45 43 11 62-56-29-55 29 10-62-45-43Z" fill="#fbfaf6" stroke="#20211e" stroke-linejoin="bevel" stroke-width="6"/>
</svg>`;

export const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="13" fill="#20211e"/>
  <path d="M10 32h33" stroke="#fbfaf6" stroke-linecap="square" stroke-width="7"/>
  <path d="m34 17 15 15-15 15" fill="none" stroke="#d8b64b" stroke-linecap="square" stroke-linejoin="miter" stroke-width="7"/>
  <path d="M11 16h13M11 48h13" stroke="#a43f24" stroke-width="5"/>
</svg>`;
