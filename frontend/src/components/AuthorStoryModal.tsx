export default function AuthorStoryModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <div role="dialog" aria-label="关于 ZeroWall Science" className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" onClick={onClose}><section className="max-w-lg rounded-xl bg-app-bg p-8 text-tx-primary" onClick={e => e.stopPropagation()}><img src="/admin/zerowall-icon.png" width="56" alt=""/><h2 className="my-4 text-xl font-bold">ZeroWall Science 文档中心</h2><p>面向科研用户的产品介绍、使用指南与知识管理。</p><p className="my-4 text-sm">文档编辑系统基于 Nowen Note，遵循 GPL-3.0 许可。ZeroWall Science 桌面产品使用其自身许可证。</p><a href="/docs/">查看文档</a><button className="ml-6" onClick={onClose}>关闭</button></section></div>;
}
