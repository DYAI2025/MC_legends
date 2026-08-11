export function AvaloriaHeroArt() {
  return (
    <svg
      className="hero-art"
      viewBox="0 0 800 520"
      role="img"
      aria-label="Eine helle Blockwelt mit weißem Turm, Brücke, Fluss und grünen Hügeln"
      focusable="false"
    >
      <defs>
        <linearGradient id="sky" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#9ee8ff" />
          <stop offset="1" stopColor="#f8f1cc" />
        </linearGradient>
        <linearGradient id="water" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#65d0df" />
          <stop offset="1" stopColor="#3285bd" />
        </linearGradient>
      </defs>
      <rect width="800" height="520" fill="url(#sky)" />
      <rect x="0" y="308" width="800" height="212" fill="#85c866" />
      <path d="M0 330 100 244 190 304 285 220 382 306 480 240 580 310 683 215 800 302V520H0Z" fill="#4f9f5e" />
      <path d="M480 320 565 304 625 336 591 520 440 520Z" fill="url(#water)" />
      <path d="M0 408 133 371 230 399 335 365 440 403 520 380 620 414 800 376V520H0Z" fill="#a6d873" />

      <g className="hero-pine" fill="#2d784b">
        <path d="m96 314 27-75 27 75Z" />
        <path d="m58 340 38-103 38 103Z" />
        <path d="m690 302 30-85 30 85Z" />
        <path d="m645 335 45-120 45 120Z" />
      </g>

      <g className="hero-citadel">
        <path d="M245 340V182h116v158Z" fill="#fffaf1" />
        <path d="m236 182 67-58 67 58Z" fill="#f7f0d9" />
        <path d="M271 156V91h34v65ZM328 156V82h34v74Z" fill="#fffaf1" />
        <path d="m266 91 22-25 22 25ZM323 82l22-28 22 28Z" fill="#e5c873" />
        <path d="M270 235h28v42h-28ZM316 235h28v42h-28Z" fill="#83c8d7" />
        <rect x="290" y="302" width="27" height="38" fill="#d8ad5a" />
        <path d="M224 340h159l22 24H202Z" fill="#d8bf81" />
      </g>

      <g className="hero-bridge" fill="#c99050">
        <rect x="355" y="350" width="168" height="18" />
        <rect x="370" y="368" width="18" height="50" />
        <rect x="488" y="368" width="18" height="50" />
        <rect x="353" y="340" width="18" height="28" />
        <rect x="507" y="340" width="18" height="28" />
      </g>
      <path d="M372 350q58-55 135 0" fill="none" stroke="#f3d28a" strokeWidth="8" />
      <g fill="#fff5c4" opacity="0.85">
        <rect x="555" y="170" width="8" height="8" />
        <rect x="594" y="124" width="6" height="6" />
        <rect x="640" y="181" width="7" height="7" />
        <rect x="156" y="148" width="7" height="7" />
      </g>
    </svg>
  );
}
