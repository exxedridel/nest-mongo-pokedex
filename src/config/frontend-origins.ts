const DEFAULT_FRONTEND_ORIGINS = [
  'http://localhost:5173',
  'https://mern-app.up.railway.app',
];

export function getFrontendOrigins(): string[] {
  const extraOrigins = (process.env.FRONTEND_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return [...new Set([...DEFAULT_FRONTEND_ORIGINS, ...extraOrigins])];
}

export function isAllowedFrontendOrigin(origin: string | undefined): boolean {
  // Native clients have no Origin header; they still need a valid signed JWT.
  return !origin || getFrontendOrigins().includes(origin);
}
