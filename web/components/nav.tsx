/**
 * 顶部导航栏
 * Claude 风格：暖色调、简洁、serif 标题
 */

import Link from 'next/link';

const NAV_ITEMS = [
  { href: '/',         label: 'Dashboard' },
  { href: '/tasks',    label: 'Tasks' },
  { href: '/sessions', label: 'Sessions' },
];

export function Nav() {
  return (
    <nav className="sticky top-0 z-50 bg-ivory/95 backdrop-blur-sm border-b border-border-cream">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2.5">
          <span className="font-serif text-xl font-medium text-near-black tracking-tight">
            Floo
          </span>
          <span className="text-xs font-mono text-stone-gray px-1.5 py-0.5 rounded bg-warm-sand">
            monitor
          </span>
        </Link>

        {/* Nav Links */}
        <div className="flex items-center gap-6">
          {NAV_ITEMS.map(item => (
            <Link
              key={item.href}
              href={item.href}
              className="text-sm text-olive-gray hover:text-near-black transition-colors"
            >
              {item.label}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
