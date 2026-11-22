// SPDX-License-Identifier: Apache-2.0

package protocol

// CardPlacements are the places a host shows a card: in the conversation, in its side panel, or inside a
// document block. The same card mount draws it in every place (see placement.ts in the TypeScript reference).
var CardPlacements = []string{"inline", "panel", "document"}

// IsCardPlacement reports whether value is one of CardPlacements.
func IsCardPlacement(value any) bool {
	s, ok := value.(string)
	return ok && contains(CardPlacements, s)
}

// CanPlaceCard reports whether a card kind may be shown at placement. An interactive kind asks the user
// something and is only ever shown inline. interactive is nil when the host has no definition for the kind.
func CanPlaceCard(interactive *bool, placement any) bool {
	if !IsCardPlacement(placement) {
		return false
	}
	return placement == "inline" || interactive == nil || !*interactive
}
