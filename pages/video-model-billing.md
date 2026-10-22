# Video model billing and retries

Studio AI-video generation, lip-sync layers, sound-effect layers, rerolled scenes and direct hosted model endpoints settle individual completed calls. See [final customer output prices](https://docs.samsar.one/pricing#video-model-calls).

Production agent pipelines retain their fixed stage prices. Standalone editions waive local credit debits. When a standalone agent or Studio worker calls hosted Samsar through Samsar.js, the hosted endpoint records the charge once.

### Final AI-video output prices

These prices apply to individual model calls on the named native adapter. Per-second prices refer to generated output before scene trimming or padding. Multiple completed outputs are billable individually.

| Model | Adapter | Configuration | Unit | Credits |
| --- | --- | --- | --- | --- |
| `RUNWAYML` | Runway | Gen-4.5 | second | 14.4 |
| `VEO3.1 / VEO3.1I2V` | Google Cloud | 720p / 1080p, video | second | 24 |
| `VEO3.1 / VEO3.1I2V` | Google Cloud | 720p / 1080p, video + audio | second | 48 |
| `VEO3.1FAST / VEO3.1I2VFAST` | Google Cloud | 720p, video | second | 9.6 |
| `VEO3.1FAST / VEO3.1I2VFAST` | Google Cloud | 720p, video + audio | second | 12 |
| `VEO3.1FAST / VEO3.1I2VFAST` | Google Cloud | 1080p, video | second | 12 |
| `VEO3.1FAST / VEO3.1I2VFAST` | Google Cloud | 1080p, video + audio | second | 14.4 |
| `HAPPYHORSEI2V` | Alibaba international | Happy Horse 1.1, 720p | second | 16.8 |
| `HAPPYHORSEI2V` | Alibaba China / global | Happy Horse 1.1, 720p | second | 14.85228 |
| `HAILUOPRO` | MiniMax | Hailuo 02, 768p, 6 seconds | clip | 33.6 |
| `HAILUOPRO` | MiniMax | Hailuo 02, 768p, 10 seconds | clip | 67.2 |

Supported Fal AI-video routes have [their own final model-call rates](https://docs.samsar.one/pricing#video-model-calls) for the selected configuration. The Fal rates are checked into the worker and include a 20% markup over the provider base price at 100 credits per USD. Submitted per-second options and measured Seedance video-token output determine the completed charge. Hosted direct adapter-billed Fal requests for Haiper 2.0, Magi Distilled, 10-second Pika 2.2, 121-frame Wan 2.2 5B and PixVerse durations other than five or eight seconds currently lack a verified tariff and stop before a paid submission.

### Fal-backed lip-sync pricing

The four verified Fal tariffs below include a 20% markup at 100 credits per USD. Each completed hosted model call has one charge.

| Model key | Fal price | Final Samsar price |
| --- | --- | --- |
| [`SYNCLIPSYNC`](https://fal.ai/models/fal-ai/sync-lipsync/v3) | $8 per output minute | 16 credits per measured output second |
| [`LATENTSYNC`](https://fal.ai/models/fal-ai/latentsync) | $0.20 per video through 40 seconds; $0.005 per output second above 40 seconds | 24 credits per video through 40 seconds; 0.6 credits per output second above 40 seconds |
| [`KLINGLIPSYNC`](https://fal.ai/models/fal-ai/kling-video/lipsync/audio-to-video) | $0.014 per input-video second, rounded up to 5-second blocks | 1.68 credits per billable input-video second, in 5-second blocks |
| [`CREATIFYLIPSYNC`](https://fal.ai/models/creatify/lipsync) | $1 per video minute | 2 credits per measured output second |
| [`HUMMINGBIRDLIPSYNC`](https://fal.ai/models/fal-ai/tavus/hummingbird-lipsync/v0) | Current price unverified | 15 credits per requested second, historical fallback |

LatentSync's above-40-second rate applies to the entire output. Creatify's public price does not say whether input or output duration is billed; Samsar uses measured output duration. Fal's Kling pricing callout says $0.014 per input second rounded to five seconds, while nearby explanatory prose says $0.014 per block; Samsar follows the callout. Hummingbird's current Fal price cannot be verified, so its fallback is not presented as a verified provider price plus markup.

### Fal-backed video sound-effect pricing

Fal's authenticated pricing API lists [`MMAUDIOV2`](https://fal.ai/models/fal-ai/mmaudio-v2) at $0.001 per generated audio second and [`MIRELOAI`](https://fal.ai/models/mirelo-ai/sfx1.6/video-to-video) at $0.01 per second. At 100 credits per USD with a 20% adapter markup, Samsar uses the submitted duration for final hosted rates of **0.12 credits per submitted audio second** and **1.2 credits per submitted second per sample**, respectively. MMAudio defaults to eight seconds when duration is omitted. New Mirelo calls request one sample; older calls that omitted `num_samples` used Fal's two-sample default.

Fal's SFX1.6 page does not explicitly say whether seconds multiply by sample count. The per-sample basis is inferred from [Fal's earlier Mirelo model](https://fal.ai/models/mirelo-ai/sfx-v1/video-to-video), [Fal's SFX2.0 model](https://fal.ai/models/mirelo-ai/sfx2.0/video-to-video), and a legacy two-output response; it is not invoice-verified. Other Fal or GMICloud AI-video calls have configuration-specific final charges in completion receipts. Billing confirmation may remain pending after generation. Audio-only sound effects use their separate [audio endpoint prices](https://docs.samsar.one/external-requests#audio).

## Endpoint scope

| Operation | Hosted route | Receipt |
| --- | --- | --- |
| Image-to-video | `/v2/external/video/image_to_video`, `/direct_image_to_video` | Completed model call |
| Direct text-to-video | `/v2/external/video/direct_text_to_video` | Completed model call |
| Lip sync | `/v2/external/video/lip_sync` | Completed model call |
| Sound-effect layer | `/v2/external/video/sound_effect` | Completed model call |
| Scene reroll | `/v2/reroll-layers` | Each completed image and media-model call |
| Full production agent workflow | `/v2/external/video/text_to_video` and narrative/render workflows | Existing fixed stage pricing |

Direct text-to-video accepts `VEO3.1`, `VEO3.1FAST` and `HAILUOPRO`. It does not run narrative planning or generate starting images.

## Retry contract

Supply a stable `Idempotency-Key` or `client_request_id`. Replays retain their original job and charge; changed payloads return `409`. Use a new key for an intentional new call. Status responses include `creditsCharged`, `remainingCredits` and `billingStatus`.

The worker retains a completed clip before billing and delivery. Billing confirmation, ledger repair and delivery retries reuse that clip. Existing prepaid jobs are not charged again. Financial receipts have no queue TTL; background reconciliation continues after queue cleanup.

## Provider configuration

Fal-backed lip-sync, video sound-effect and supported AI-video calls use versioned model tariff constants. Completion billing calculates the charge from the saved request configuration and output metadata; it does not fetch Fal Billing Events or a model price during processing. A model or configuration without a verified tariff is not eligible for a new hosted paid call.

The GenBlaze gateway forwards media cost metadata when available. For Seedance 2.0 (`seedance-2-0-260128`), if the response omits cost, the gateway uses checked-in account rates of $0.07, $0.152 or $0.374 per requested second at 480p, 720p or 1080p, respectively. It does not fetch a live model price card. Other GMICloud calls still require valid provider cost metadata; a missing cost leaves the completed output pending and is never treated as a free call or priced using another adapter's rates.

## Regression checks

Run the AI-video worker test suite, processor video-billing and reroll tests, Express stage-billing tests, and the gateway media-billing tests. These cover concurrent callbacks, provider cost confirmation, balance/ledger recovery, checkpoint failures, delivery retries, standalone waiver and preservation of production agent prices.
