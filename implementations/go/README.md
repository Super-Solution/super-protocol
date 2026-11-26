# Super Protocol, Go

`protocol`: plugin manifest, editor, chart and plot card validators, card references (`ParseCardRef`, `FormatCardRef`,
`ParseChartRef`), card placement (`IsCardPlacement`, `CanPlaceCard`), host theme (`ReadHostTheme`, `ThemeVariables`), tool authority (`PluginToolAuthority`, `ValidateChatPluginData`), the
gateway's request, message and stream-event validators (`ValidateInferenceRequest`, `ValidateInferenceMessage`,
`ValidateStreamEvent`, `InferenceStreamOutcomeOf`), run events (`ValidateRunEvent`, `RunStreamOutcomeOf`)
and an incremental SSE parser.
The TypeScript package in [`../typescript`](../typescript) is the reference; this port reproduces every
case in [`../../conformance`](../../conformance/README.md), messages included. Standard library only.

```go
import "github.com/Super-Solution/super-protocol/implementations/go/protocol"
```

```bash
go test ./...                              # conformance cases
go test ./protocol -bench . -benchmem      # chart card validation about 1.6 µs, 2 allocations
go vet ./... && gofmt -l .
```

Inputs are decoded JSON (`json.Unmarshal` into `any`). Apache-2.0. Copyright SUPER SOLUTION LABS INC.
