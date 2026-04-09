/**
 * 空状态占位组件
 * 当列表为空时显示友好提示
 */

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-16 h-16 rounded-2xl bg-warm-sand flex items-center justify-center mb-4">
        <span className="text-2xl text-stone-gray">~</span>
      </div>
      <h3 className="font-serif text-lg text-charcoal-warm mb-1">{title}</h3>
      <p className="text-sm text-stone-gray max-w-sm">{description}</p>
    </div>
  );
}
