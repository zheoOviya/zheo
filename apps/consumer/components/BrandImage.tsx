import Image from "next/image";

interface BrandImageProps {
  src?: string | null;
  alt?: string;
  sizes?: string;
  priority?: boolean;
  className?: string;
}

export function BrandImage({ src, alt = "", sizes, priority, className }: BrandImageProps) {
  if (src) {
    return (
      <Image
        src={src}
        alt={alt}
        fill
        sizes={sizes}
        priority={priority}
        className={className}
      />
    );
  }

  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-primary-400 via-primary-500 to-primary-700"
    >
      <svg
        className="h-1/3 w-1/3 text-white/60"
        fill="currentColor"
        viewBox="0 0 24 24"
      >
        <path d="M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z" />
      </svg>
    </div>
  );
}
