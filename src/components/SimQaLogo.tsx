// The SimQA mark, in one place.
//
// It was duplicated — byte for byte — in the sidebar and on the sign-in
// screen, which is how the two drifted into carrying different names for the
// same product. One definition means the brand can only ever be changed once.

export function SimQaLogo({ size = 32 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width={size} height={size} role="img" aria-label="SimQA">
      <rect x="0" y="0" width="64" height="64" rx="14" fill="#FF6A00" />
      <circle cx="29" cy="27" r="14" fill="#FFD3A5" />
      <path d="M15 26 Q13 16 19 12 Q24 14 22 22 Z" fill="#2D1B0E" />
      <path d="M43 26 Q45 16 39 12 Q34 14 36 22 Z" fill="#2D1B0E" />
      <circle cx="23" cy="27" r="4" fill="#FFFFFF" stroke="#1A1A1A" strokeWidth="1.6" />
      <circle cx="35" cy="27" r="4" fill="#FFFFFF" stroke="#1A1A1A" strokeWidth="1.6" />
      <line x1="27" y1="27" x2="31" y2="27" stroke="#1A1A1A" strokeWidth="1.6" />
      <circle cx="23" cy="27" r="1.3" fill="#1A1A1A" />
      <circle cx="35" cy="27" r="1.3" fill="#1A1A1A" />
      <path d="M19 35 Q23 39 29 37 Q35 39 39 35 Q38 41 31 41 Q22 41 19 35 Z" fill="#2D1B0E" />
      <path d="M25 43 Q29 46 33 43" stroke="#1A1A1A" strokeWidth="1.3" fill="none" strokeLinecap="round" />
      <circle cx="48" cy="46" r="9" fill="#FFFFFF" fillOpacity="0.9" stroke="#1A1A1A" strokeWidth="2" />
      <line x1="55" y1="53" x2="62" y2="60" stroke="#1A1A1A" strokeWidth="3" strokeLinecap="round" />
      <ellipse cx="48" cy="46" rx="2.4" ry="1.6" fill="#16A34A" />
      <line x1="45.5" y1="45" x2="43.5" y2="44" stroke="#16A34A" strokeWidth="0.9" strokeLinecap="round" />
      <line x1="50.5" y1="45" x2="52.5" y2="44" stroke="#16A34A" strokeWidth="0.9" strokeLinecap="round" />
      <line x1="45.5" y1="47" x2="43.5" y2="48" stroke="#16A34A" strokeWidth="0.9" strokeLinecap="round" />
      <line x1="50.5" y1="47" x2="52.5" y2="48" stroke="#16A34A" strokeWidth="0.9" strokeLinecap="round" />
    </svg>
  );
}
