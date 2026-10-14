#!/usr/bin/env bash
# Generates the test media (needs ffmpeg with libx264 / libx265 / aac)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p assets && cd assets
q() { ffmpeg -hide_banner -loglevel error -y "$@"; }

echo "1/8 test video (24 s, 720p H.264 + AAC)"
q -f lavfi -i "testsrc2=size=1280x720:rate=30" -f lavfi -i "sine=frequency=440:sample_rate=44100" -t 24 \
  -c:v libx264 -preset veryfast -g 60 -bf 2 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart video.mp4

echo "2/8 multi-quality HLS (360p / 720p, TS segments)"
mkdir -p hls/ts
q -i video.mp4 -filter_complex "[0:v]split=2[v1][v2];[v1]scale=640:360[v360];[v2]copy[v720]" \
  -map "[v360]" -map 0:a -map "[v720]" -map 0:a -c:v libx264 -preset veryfast -g 60 -bf 2 -c:a aac -b:a 96k \
  -b:v:0 600k -b:v:1 2000k -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_filename "hls/ts/v%v_%03d.ts" \
  -master_pl_name master.m3u8 -var_stream_map "v:0,a:0,name:360p v:1,a:1,name:720p" "hls/ts/stream_%v.m3u8"

# A playlist that changes resolution partway (like an inserted ad with a discontinuity)
{
  printf '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n'
  for i in 000 001 002 003; do printf '#EXTINF:2.000000,\nv360p_%s.ts\n' "$i"; done
  printf '#EXT-X-DISCONTINUITY\n'
  for i in 004 005 006 007; do printf '#EXTINF:2.000000,\nv720p_%s.ts\n' "$i"; done
  printf '#EXT-X-ENDLIST\n'
} > hls/ts/mixed.m3u8

echo "3/8 AES-128 encrypted HLS"
mkdir -p hls/aes
head -c 16 /dev/urandom > hls/aes/enc.key
printf 'enc.key\nhls/aes/enc.key\n%s\n' "$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')" > keyinfo.txt
q -i video.mp4 -c copy -f hls -hls_time 2 -hls_playlist_type vod -hls_key_info_file keyinfo.txt \
  -hls_segment_filename "hls/aes/seg_%03d.ts" hls/aes/index.m3u8

echo "4/8 fMP4 segment HLS"
mkdir -p hls/fmp4
q -i video.mp4 -c copy -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 \
  -hls_fmp4_init_filename init.mp4 -hls_segment_filename "hls/fmp4/seg_%03d.m4s" hls/fmp4/index.m3u8

echo "5/8 HEVC HLS (for the TS fallback test)"
mkdir -p hls/hevc
q -i video.mp4 -t 8 -c:v libx265 -preset ultrafast -x265-params log-level=error -c:a aac -f hls -hls_time 2 \
  -hls_playlist_type vod -hls_segment_filename "hls/hevc/seg_%03d.ts" hls/hevc/index.m3u8

echo "6/8 live segments"
mkdir -p live
q -i video.mp4 -c copy -f hls -hls_time 2 -hls_list_size 0 -hls_segment_filename "live/seg_%03d.ts" live/full.m3u8

echo "7/8 separate audio/video tracks (fragmented and regular MP4)"
mkdir -p dash
q -i video.mp4 -map 0:v -c copy -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof+global_sidx dash/video.m4s
q -i video.mp4 -map 0:a -c copy -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof+global_sidx -frag_duration 2000000 dash/audio.m4s
q -i video.mp4 -map 0:v -c copy -movflags +faststart dash/prog_video.mp4
q -i video.mp4 -map 0:a -c copy dash/prog_audio_moovend.m4a

echo "8/8 64 MB random file"
head -c 67108864 /dev/urandom > big.bin
echo "done: $(pwd)"
