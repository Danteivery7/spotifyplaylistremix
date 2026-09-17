"use client";

import AutomaticYouTubeMatcher from "@/components/automatic-youtube-matcher";
import AudioEngineStage from "@/components/audio-engine-stage";
import type { PlaylistPayload } from "@/lib/types";

type Props = {
  playlist: PlaylistPayload;
  onReadyChange?: (ready: boolean) => void;
};

export default function AudioSourceStageV2({ playlist, onReadyChange }: Props) {
  return (
    <>
      <AutomaticYouTubeMatcher playlist={playlist} />
      <AudioEngineStage playlist={playlist} onReadyChange={onReadyChange} />
    </>
  );
}
