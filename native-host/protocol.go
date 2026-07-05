package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	ProtocolVersion   = 1
	RequestPlanType   = "TAB_GROUP_PLAN_REQUEST"
	RequestStatusType = "NATIVE_HOST_STATUS_REQUEST"
	RequestPingType   = "PING"
	ResponseType      = "TAB_GROUP_PLAN_RESPONSE"
	MaxMessageBytes   = 1024 * 1024
	MaxTabs           = 200
	MaxExistingGroups = 50
)

type Tab struct {
	ID       int         `json:"id"`
	Title    string      `json:"title"`
	Domain   string      `json:"domain"`
	URL      string      `json:"url,omitempty"`
	PageHint string      `json:"pageHint,omitempty"`
	Context  *TabContext `json:"context,omitempty"`
}

type TabContext struct {
	CanonicalURL    string   `json:"canonicalUrl"`
	Path            string   `json:"path"`
	SiteName        string   `json:"siteName"`
	MetaDescription string   `json:"metaDescription"`
	OGTitle         string   `json:"ogTitle"`
	OGDescription   string   `json:"ogDescription"`
	Headings        []string `json:"headings"`
	VisibleText     string   `json:"visibleText"`
	Source          string   `json:"source"`
	Truncated       bool     `json:"truncated"`
}

type Request struct {
	Version          int             `json:"version"`
	Type             string          `json:"type"`
	RequestID        string          `json:"requestId"`
	Provider         string          `json:"provider,omitempty"`
	TimeoutMS        int             `json:"timeoutMs,omitempty"`
	MinimumGroupSize int             `json:"minimumGroupSize,omitempty"`
	IncludeFullURLs  bool            `json:"includeFullUrls,omitempty"`
	IncludePageHints bool            `json:"includePageHints,omitempty"`
	ExistingGroups   []ExistingGroup `json:"existingGroups,omitempty"`
	Tabs             []Tab           `json:"tabs,omitempty"`
}

type ExistingGroup struct {
	ID     int    `json:"id"`
	Title  string `json:"title"`
	Color  string `json:"color"`
	TabIDs []int  `json:"tabIds"`
}

type Plan struct {
	Groups      []PlanGroup      `json:"groups"`
	Assignments []PlanAssignment `json:"assignments,omitempty"`
}

type PlanGroup struct {
	Name   string `json:"name"`
	Color  string `json:"color"`
	TabIDs []int  `json:"tabIds"`
}

type PlanAssignment struct {
	GroupID int   `json:"groupId"`
	TabIDs  []int `json:"tabIds"`
}

type Response struct {
	Version   int            `json:"version"`
	Type      string         `json:"type"`
	RequestID string         `json:"requestId"`
	OK        bool           `json:"ok"`
	Provider  string         `json:"provider,omitempty"`
	Duration  int64          `json:"durationMs,omitempty"`
	Plan      *Plan          `json:"plan,omitempty"`
	Status    *Status        `json:"status,omitempty"`
	Error     *ResponseError `json:"error,omitempty"`
}

type Status struct {
	Provider            string `json:"provider"`
	Configured          bool   `json:"configured"`
	ExecutableAvailable bool   `json:"executableAvailable"`
	AuthChecked         bool   `json:"authChecked"`
	Authenticated       bool   `json:"authenticated"`
	LockExecutables     bool   `json:"lockExecutables"`
}

type ResponseError struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

func ReadNativeMessage(reader io.Reader) (Request, error) {
	var sizeBytes [4]byte
	if _, err := io.ReadFull(reader, sizeBytes[:]); err != nil {
		return Request{}, err
	}
	size := binary.LittleEndian.Uint32(sizeBytes[:])
	if size == 0 || size > MaxMessageBytes {
		return Request{}, fmt.Errorf("invalid native message size: %d", size)
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return Request{}, err
	}
	var request Request
	if err := json.Unmarshal(payload, &request); err != nil {
		return Request{}, err
	}
	return request, nil
}

func WriteNativeMessage(writer io.Writer, response Response) error {
	payload, err := json.Marshal(response)
	if err != nil {
		return err
	}
	if len(payload) > MaxMessageBytes {
		return errors.New("native response is too large")
	}
	var sizeBytes [4]byte
	binary.LittleEndian.PutUint32(sizeBytes[:], uint32(len(payload)))
	if _, err := writer.Write(sizeBytes[:]); err != nil {
		return err
	}
	_, err = writer.Write(payload)
	return err
}

func ValidateRequest(request Request) error {
	if request.Version != ProtocolVersion {
		return errors.New("unsupported protocol version")
	}
	if request.RequestID == "" || len(request.RequestID) > 128 {
		return errors.New("invalid request id")
	}
	if request.Type == RequestPingType {
		return nil
	}
	if request.Type != RequestPlanType && request.Type != RequestStatusType {
		return errors.New("invalid request type")
	}
	if request.Provider != "codex" && request.Provider != "claude" {
		return errors.New("invalid provider")
	}
	if request.Type == RequestStatusType {
		return nil
	}
	if request.MinimumGroupSize < 2 || request.MinimumGroupSize > 10 {
		return errors.New("invalid minimum group size")
	}
	if request.TimeoutMS < 1000 || request.TimeoutMS > 30000 {
		return errors.New("invalid timeout")
	}
	if len(request.Tabs) == 0 || len(request.Tabs) > MaxTabs {
		return errors.New("invalid tab count")
	}
	seen := map[int]bool{}
	for _, tab := range request.Tabs {
		if tab.ID <= 0 || seen[tab.ID] {
			return errors.New("invalid tab id")
		}
		seen[tab.ID] = true
		if len(tab.Title) > 300 || len(tab.Domain) > 120 || len(tab.URL) > 1000 || len(tab.PageHint) > 1000 {
			return errors.New("tab context is too large")
		}
		if err := validateTabContext(tab.Context); err != nil {
			return err
		}
	}
	if len(request.ExistingGroups) > MaxExistingGroups {
		return errors.New("invalid existing group count")
	}
	for _, group := range request.ExistingGroups {
		if len(group.Title) > 64 {
			return errors.New("existing group title is too large")
		}
		if group.Color != "" && !isAllowedTabGroupColor(group.Color) {
			return errors.New("invalid existing group color")
		}
	}
	return nil
}

func validateTabContext(context *TabContext) error {
	if context == nil {
		return nil
	}
	if len(context.CanonicalURL) > 300 ||
		len(context.Path) > 300 ||
		len(context.SiteName) > 300 ||
		len(context.MetaDescription) > 300 ||
		len(context.OGTitle) > 300 ||
		len(context.OGDescription) > 300 ||
		len(context.VisibleText) > 600 {
		return errors.New("tab context is too large")
	}
	if context.Source != "page" {
		return errors.New("invalid tab context source")
	}
	if len(context.Headings) > 5 {
		return errors.New("tab context is too large")
	}
	for _, heading := range context.Headings {
		if len(heading) > 160 {
			return errors.New("tab context is too large")
		}
	}
	payload, err := json.Marshal(context)
	if err != nil {
		return err
	}
	if len(payload) > 2000 {
		return errors.New("tab context is too large")
	}
	return nil
}

func isAllowedTabGroupColor(color string) bool {
	for _, allowed := range []string{"grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"} {
		if color == allowed {
			return true
		}
	}
	return false
}

func StatusResponse(request Request, status Status) Response {
	return Response{
		Version:   ProtocolVersion,
		Type:      ResponseType,
		RequestID: request.RequestID,
		OK:        true,
		Provider:  "local-" + request.Provider + "-cli",
		Status:    &status,
	}
}

func SuccessResponse(request Request, plan Plan, durationMS int64) Response {
	return Response{
		Version:   ProtocolVersion,
		Type:      ResponseType,
		RequestID: request.RequestID,
		OK:        true,
		Provider:  "local-" + request.Provider + "-cli",
		Duration:  durationMS,
		Plan:      &plan,
	}
}

func ErrorResponse(request Request, kind string, err error) Response {
	return Response{
		Version:   ProtocolVersion,
		Type:      ResponseType,
		RequestID: request.RequestID,
		OK:        false,
		Error: &ResponseError{
			Kind:    kind,
			Message: err.Error(),
		},
	}
}
