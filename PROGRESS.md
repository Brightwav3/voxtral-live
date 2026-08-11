# Progress

Stav k 12. 8. 2026. Testy: 109/109 prochází (`npm test`). Ověřeno naživo na
Logitech G432 (vstup 13, výstup 19).

## Funguje

- Obousměrná hlasová konverzace: řeč → přepis → LLM → řeč.
- TTS: PCM se dekóduje jako float32 LE, výstupní stream se po přehrání zavírá.
- Barge-in: skočení do řeči asistenta ho zastaví a založí nový tah.
- Detekce řeči se přizpůsobuje šumu místa, nevyžaduje hlasitou mluvu.
- Přerušená odpověď se ukládá do historie, konverzace se neopakuje.

## Vyřešené problémy

| Problém | Příčina | Oprava |
| --- | --- | --- |
| Mikrofon reagoval jen na hlasitou řeč | Pevný práh `startRms=0.02` byl nad úrovní tichého headsetu | Adaptivní práh podle změřeného šumového dna (`src/audio/vad.mjs`) |
| Start řeči trval ~1,4 s, konec řeči nenastal nikdy | Driver dodával ~470 ms zvuku v jednom bloku, VAD ho počítal jako jeden 20ms rámec | Framer krájí vstup na přesných 640 B / 20 ms (`src/audio/portaudio-backend.mjs`) |
| `user_started` přišlo, `user_transcript` nikdy | Provider posílá `transcription.done` až po `input_audio.end`, které daemon neposílal | `endInput()` na konci řeči (`src/providers/mistral-realtime-stt.mjs`) |
| Po první odpovědi daemon ohluchl | Provider po `transcription.done` socket zavírá (kód 1011), nebyl reconnect | Automatická obnova session + reconnect na `closed` |
| Asistent odpovídal pořád stejně a čím dál podrážděněji | Přerušená odpověď se nezapsala do historie, model viděl jen řadu `user` zpráv | Přerušená odpověď se ukládá jako `assistant` (`src/conversation/session.mjs`) |
| Nesrozumitelná chyba u WASAPI zařízení | Hlášku z PortAudio nešlo přiřadit k zařízení | Chyba obsahuje zařízení, host API, požadovanou i výchozí frekvenci |

## Co ladíme

1. **Ozvěna z headsetu.** Mikrofon G432 částečně chytá zvuk ze sluchátek. Zatím
   nespouští falešný barge-in, ale při vyšší hlasitosti to hrozí. Obcházka:
   `--audio-profile speaker --echo-cancel`. Otevřená otázka, zda echo
   suppressor zapnout i pro profil `headset`.
2. **Prodleva mezi tahy.** Po každém dotazu se otevírá nová STT session
   (~200–500 ms). Zvážit předotevření náhradního socketu.
3. **Citlivost v hlučném prostředí.** Adaptivní práh je stropován na
   `maxStartRms=0.05`; v hlučné místnosti může být potřeba `--vad-sensitivity low`.
   Zatím neověřeno mimo tichou místnost.
4. **Jazyk odpovědí.** Model odpovídá anglicky i na české vstupy; není nastaven
   systémový prompt ani jazyk pro STT.
5. **Zařízení 29/27 (WASAPI)** nelze použít — odmítají 16 kHz a 24 kHz. Používej
   13/19 (DirectSound) nebo 1/7 (MME).

## Diagnostické nástroje

- `node scripts/vad-check.mjs --input-device 13 --seconds 15` — živé úrovně,
  práh, šumové dno a události detektoru.
- `node --env-file=.env scripts/stt-probe.mjs --input-device 13 --seconds 8` —
  vypíše typy zpráv, které vrací realtime STT. API klíč nikdy netiskne.
