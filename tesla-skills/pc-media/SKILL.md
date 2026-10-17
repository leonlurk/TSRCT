---
name: pc-media
description: Play music on Spotify (an artist, song, genre, mood or a surprise) that really starts playing, plus play, pause, skip, previous track, volume up/down/max and mute with the media keys. Instant, no window and no screenshot. Use for any music or volume request.
---

# Music and volume

`D=/mnt/c/Users/you/PROJECTS/TSRCT/scripts/desk.js`

```
node $D media --keys playpause                 # play / pause whatever is playing
node $D media --keys nexttrack                 # next      (prevtrack = previous)
node $D media --keys volumeup --times 5        # +10 % (Windows moves 2 % per press)
node $D media --keys volumedown --times 5
node $D media --keys volumeup --times 50       # to the maximum
node $D media --keys volumemute
node $D music --query "sade"                   # PLAYS it now: an artist, a song, a genre or a mood
node $D music                                  # no query = a surprise pick, plays at once
node $D spotify --query "bad bunny"            # only OPENS the search results (nothing plays)
node $D shortcut --name "spotify aleatorio"    # shuffle (spotify repetir = repeat)
```

- Music is never a question: if he says "pone algo", choose and play it; do not ask which.
- To PLAY anything: `music --query`. It answers with what is really playing. Never the mouse for music.
- Volume never needs a look.
