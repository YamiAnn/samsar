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

### Lip-sync and video sound-effect pricing

| Operation | Model keys | Final customer price |
| --- | --- | --- |
| Lip-sync layer | `SYNCLIPSYNC`, `LATENTSYNC`, `KLINGLIPSYNC`, `HUMMINGBIRDLIPSYNC`, `CREATIFYLIPSYNC` | Configuration-specific completed-call charge; reported in the final credit receipt |
| Video sound-effect layer | `MMAUDIOV2`, `MIRELOAI` | Configuration-specific completed-call charge; reported in the final credit receipt |
| Other Fal or GMICloud AI-video calls | Selected model and configuration | Final completed-call charge in the credit receipt |

These operations have no universal flat per-scene price. Billing confirmation may remain pending after generation. Audio-only sound effects use their separate [audio endpoint prices](https://docs.samsar.one/external-requests#audio).

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

Fal completion billing requires billing-read access. Set `providers.fal.billingApiKey` in deployment configuration, rendered as `FAL_BILLING_API_KEY`; the ordinary Fal key is used when this is omitted. The key must have the [Fal billing-event permissions](https://fal.ai/docs/platform-apis/v1/models/billing-events).

The GenBlaze gateway forwards media cost metadata when available. GenBlaze deployments must configure a pricing strategy that supplies that metadata. Missing or invalid cost confirmation remains pending with the completed output retained; it is never treated as a free call or priced using another adapter's rates.

## Regression checks

Run the AI-video worker test suite, processor video-billing and reroll tests, Express stage-billing tests, and the gateway media-billing tests. These cover concurrent callbacks, provider cost confirmation, balance/ledger recovery, checkpoint failures, delivery retries, standalone waiver and preservation of production agent prices.
