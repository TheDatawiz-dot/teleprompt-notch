// On-device speech recognition helper.
//
// Reads raw 16 kHz mono Int16 PCM on stdin and writes newline-delimited JSON
// results to stdout. Recognition runs locally through the Speech framework's
// SpeechAnalyzer, so this needs no API key, no account, and no network.
//
// It uses SpeechAnalyzer/SpeechTranscriber (macOS 26) rather than the older
// SFSpeechRecognizer. Besides being the on-device path by construction, the
// older API is gated behind the Speech Recognition privacy permission, which a
// spawned command-line helper cannot obtain: it is not an app bundle macOS can
// show a prompt for, so authorization is denied outright with no way for the
// user to grant it. SpeechAnalyzer has no such gate.
//
// It deliberately does not open the microphone itself: the app already captures
// audio in the renderer, and a second capture session would mean a second
// microphone permission prompt for the same audio.

import Foundation
import Speech
import AVFoundation

let INPUT_RATE = 16000.0
let EMIT_WORD_LIMIT = 16   // the matcher only probes the last few words
let READ_CHUNK = 3200      // 100 ms of 16 kHz mono Int16

func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func lastWords(_ text: String, _ limit: Int) -> String {
    let parts = text.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" })
    guard parts.count > limit else { return text }
    return parts.suffix(limit).joined(separator: " ")
}

@main
struct Main {
    static func main() async {
        let requested = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "en-US"

        guard SpeechTranscriber.isAvailable else {
            emit(["type": "error", "message": "On-device speech recognition is not available on this Mac."])
            exit(1)
        }

        let asked = Locale(identifier: requested)
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: asked) else {
            emit(["type": "error", "message": "Speech recognition does not support \(requested) on this Mac."])
            exit(1)
        }

        let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)

        // The language model is a downloadable asset. Ask for it rather than
        // failing: on a Mac that has never used dictation it will not be present.
        if await AssetInventory.status(forModules: [transcriber]) == .unsupported {
            emit(["type": "error", "message": "No on-device speech model is available for \(locale.identifier(.bcp47))."])
            exit(1)
        }
        do {
            if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                emit(["type": "notice", "message": "downloading the on-device speech model"])
                try await install.downloadAndInstall()
            }
        } catch {
            emit(["type": "error", "message": "Could not install the on-device speech model: \(error.localizedDescription)"])
            exit(1)
        }

        guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]),
              let inputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                              sampleRate: INPUT_RATE,
                                              channels: 1,
                                              interleaved: true),
              let converter = AVAudioConverter(from: inputFormat, to: analyzerFormat) else {
            emit(["type": "error", "message": "Could not set up the audio pipeline for speech recognition."])
            exit(1)
        }

        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        let analyzer = SpeechAnalyzer(modules: [transcriber])

        // Results arrive as a growing "volatile" transcript for the current
        // utterance, then once more marked final. Both drive the scroll: the
        // volatile ones are what make the script follow speech continuously
        // instead of jumping only when the speaker pauses.
        let reader = Task {
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                    if text.isEmpty { continue }
                    emit(["type": result.isFinal ? "final" : "interim",
                          "text": lastWords(text, EMIT_WORD_LIMIT)])
                }
            } catch {
                emit(["type": "error", "message": "Speech recognition stopped: \(error.localizedDescription)"])
                exit(1)
            }
        }

        do {
            try await analyzer.start(inputSequence: stream)
        } catch {
            emit(["type": "error", "message": "Could not start speech recognition: \(error.localizedDescription)"])
            exit(1)
        }

        emit(["type": "ready", "onDevice": true, "locale": locale.identifier(.bcp47)])

        // Pump stdin. Blocking reads belong off the cooperative pool, hence the
        // detached task.
        let pump = Task.detached(priority: .userInitiated) {
            let input = FileHandle.standardInput
            while true {
                let chunk = input.availableData
                if chunk.isEmpty { break } // parent closed the pipe
                let frames = chunk.count / 2
                if frames == 0 { continue }
                guard let inBuffer = AVAudioPCMBuffer(pcmFormat: inputFormat,
                                                      frameCapacity: AVAudioFrameCount(frames)) else { continue }
                inBuffer.frameLength = AVAudioFrameCount(frames)
                chunk.withUnsafeBytes { raw in
                    if let base = raw.baseAddress, let dst = inBuffer.int16ChannelData?[0] {
                        memcpy(dst, base, frames * 2)
                    }
                }

                let ratio = analyzerFormat.sampleRate / INPUT_RATE
                let capacity = AVAudioFrameCount(Double(frames) * ratio) + 1024
                guard let outBuffer = AVAudioPCMBuffer(pcmFormat: analyzerFormat,
                                                       frameCapacity: capacity) else { continue }
                var error: NSError?
                var supplied = false
                converter.convert(to: outBuffer, error: &error) { _, status in
                    if supplied { status.pointee = .noDataNow; return nil }
                    supplied = true
                    status.pointee = .haveData
                    return inBuffer
                }
                if error != nil { continue }
                if outBuffer.frameLength > 0 {
                    continuation.yield(AnalyzerInput(buffer: outBuffer))
                }
            }
            continuation.finish()
        }

        await pump.value
        try? await analyzer.finalizeAndFinishThroughEndOfInput()
        // Let a trailing final result land before the process goes away.
        try? await Task.sleep(nanoseconds: 500_000_000)
        reader.cancel()
        exit(0)
    }
}
