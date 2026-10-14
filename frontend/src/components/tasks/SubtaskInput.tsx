import React, { useState, useRef, useEffect } from "react";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * 轻量 inline 子任务输入框。
 * 用于 TaskTreeRow / FlatTaskRow 中快速新增子任务。
 */
export function SubtaskInput({
  parentId,
  onSubmit,
  onCancel,
}: {
  parentId: string;
  onSubmit: (title: string, parentId: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async () => {
    if (!value.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(value.trim(), parentId);
      setValue("");
      // 保持焦点，方便连续新增
      inputRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex items-center gap-2 pl-8 pr-4 py-1.5">
      <Plus size={14} className="text-tx-tertiary flex-shrink-0" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSubmit();
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => {
          // 失焦时如果没有内容则关闭
          if (!value.trim()) onCancel();
        }}
        placeholder={t('tasks.addChildPlaceholder')}
        disabled={submitting}
        className="flex-1 min-w-0 bg-transparent text-sm text-tx-primary placeholder:text-tx-tertiary focus:outline-none border-b border-app-border focus:border-accent-primary transition-colors py-1"
      />
      <button
        type="button"
        aria-label={t("common.cancel")}
        onClick={onCancel}
        className="flex-shrink-0 p-0.5 rounded hover:bg-app-hover text-tx-tertiary transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  );
}
