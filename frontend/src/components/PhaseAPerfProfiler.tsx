import { Profiler, type PropsWithChildren } from "react";
import { recordPhaseAPerfEvent } from "@/lib/phaseAPerfDiagnostics";

export function PhaseAPerfProfiler({ children, id = "TiptapEditor" }: PropsWithChildren<{ id?: string }>) {
  const content = children;
  if (import.meta.env.VITE_PHASE_A_PERF !== "1") return content;
  return (
    <Profiler
      id={id}
      onRender={(profilerId, phase, actualDuration) => {
        recordPhaseAPerfEvent({
          type: "react-commit",
          durationMs: actualDuration,
          detail: { id: profilerId, phase },
        });
      }}
    >
      {content}
    </Profiler>
  );
}
