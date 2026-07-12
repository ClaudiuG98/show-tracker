import { useState } from "react";

interface PosterProps {
  title: string;
  medium?: string | undefined;
  original?: string | undefined;
  size?: "card" | "detail";
}

const initials = (title: string) => title.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]?.toUpperCase()).join("") || "TV";

export function Poster({ title, medium, original, size = "card" }: PosterProps) {
  const [failed, setFailed] = useState(false);
  const source = size === "detail" ? original ?? medium : medium ?? original;
  return <div className={`poster poster-${size}`} data-testid="poster">
    {source && !failed
      ? <img src={source} alt={`${title} poster`} loading="lazy" decoding="async" onError={() => setFailed(true)}/>
      : <div className="poster-fallback" role="img" aria-label={`No poster available for ${title}`}>
          <span className="tv-glyph" aria-hidden="true"><i/></span><strong>{initials(title)}</strong>
        </div>}
  </div>;
}
