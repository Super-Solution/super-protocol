// SPDX-License-Identifier: Apache-2.0

package protocol

import "fmt"

// PluginToolAuthorities are what running a tool can do: "read" changes nothing, "draft" produces something the user
// reviews, "act" changes or removes existing state on the user's behalf.
var PluginToolAuthorities = []string{"read", "draft", "act"}

// PluginToolPresets are the capability presets that grant each authority. A preset not listed here grants nothing.
var PluginToolPresets = map[string][]string{
	"read":  {"observer", "draft", "executor"},
	"draft": {"draft", "executor"},
	"act":   {"executor"},
}

// PluginToolAuthority is the tool's declared authority; ok is false when it is missing or not one this protocol
// version knows, and a host then keeps the tool out of every preset. tool is decoded JSON.
func PluginToolAuthority(tool any) (authority string, ok bool) {
	value, _ := get(tool, "authority")
	s, isString := asString(value)
	if !isString || !contains(PluginToolAuthorities, s) {
		return "", false
	}
	return s, true
}

// ValidateChatPluginData checks the data part of a chat plugin: the manifest, that every capability it declares is
// implemented, and the authority and confirm of each tool. plugin is decoded JSON of the form
// {manifest, cardKinds?: [{kind}], mounts?: [kind, ...], tools?: [{name, authority?, confirm?}]}: "mounts" lists the
// card kinds the plugin has a mount function for. The TypeScript reference takes the plugin object itself.
func ValidateChatPluginData(plugin any) []Issue {
	manifest := field(plugin, "manifest")
	issues := ValidatePluginManifest(manifest)
	if len(issues) > 0 {
		return issues
	}
	c := &checker{issues: issues}
	add := func(path, message string) { c.add(path, CodeReference, message) }
	kinds, mounts, tools := map[string]bool{}, map[string]bool{}, map[string]bool{}
	cardKinds, _ := get(plugin, "cardKinds")
	if list, ok := cardKinds.([]any); ok {
		for _, k := range list {
			if kind, _ := get(k, "kind"); isString(kind) {
				kinds[kind.(string)] = true
			}
		}
	}
	mountList, _ := get(plugin, "mounts")
	if list, ok := mountList.([]any); ok {
		for _, k := range list {
			if s, ok := asString(k); ok {
				mounts[s] = true
			}
		}
	}
	toolList, _ := get(plugin, "tools")
	toolItems, _ := toolList.([]any)
	for _, t := range toolItems {
		if name, _ := get(t, "name"); isString(name) {
			tools[name.(string)] = true
		}
	}
	capabilities, _ := get(manifest, "capabilities")
	for i, cap := range capabilities.([]any) {
		p := fmt.Sprintf("capabilities[%d]", i)
		surface, _ := get(cap, "surface")
		cardKind, hasCardKind := get(cap, "cardKind")
		kind, _ := asString(cardKind)
		switch surface {
		case "card":
			if !kinds[kind] {
				add(p+".cardKind", `plugin does not define card kind "`+kind+`"`)
			}
			if !mounts[kind] {
				add(p+".cardKind", `plugin has no mount for card kind "`+kind+`"`)
			}
		case "panel":
			if hasCardKind {
				if !kinds[kind] {
					add(p+".cardKind", `plugin does not define card kind "`+kind+`"`)
				}
				if !mounts[kind] {
					add(p+".cardKind", `plugin has no mount for card kind "`+kind+`"`)
				}
			}
		case "tool":
			name, _ := get(cap, "toolName")
			s, _ := asString(name)
			if !tools[s] {
				add(p+".toolName", `plugin does not define tool "`+s+`"`)
			}
		}
	}
	for i, t := range toolItems {
		// A missing authority is allowed so older plugins still load; hosts keep such a tool out of every preset.
		if authority := field(t, "authority"); !isUndefined(authority) {
			if _, ok := PluginToolAuthority(t); !ok {
				c.oneOf(fmt.Sprintf("tools[%d].authority", i), authority, PluginToolAuthorities)
			}
		}
		if confirm := field(t, "confirm"); !isUndefined(confirm) {
			c.boolean(fmt.Sprintf("tools[%d].confirm", i), confirm)
		}
	}
	return c.issues
}

// PanelCardKinds are the card kinds a plugin declared for the side panel: its "panel" capabilities that name one.
// manifest is decoded JSON.
func PanelCardKinds(manifest any) []string {
	kinds := []string{}
	capabilities, _ := get(manifest, "capabilities")
	list, _ := capabilities.([]any)
	for _, cap := range list {
		if surface, _ := get(cap, "surface"); surface != "panel" {
			continue
		}
		if kind, _ := get(cap, "cardKind"); isString(kind) && kind != "" && !contains(kinds, kind.(string)) {
			kinds = append(kinds, kind.(string))
		}
	}
	return kinds
}
