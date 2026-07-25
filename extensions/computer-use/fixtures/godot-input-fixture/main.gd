extends Control

var event_index := 0
var held_keys: Dictionary = {}
var held_buttons: Dictionary = {}
var status_label: Label
var log_label: RichTextLabel
var input_line: LineEdit
var log_lines: Array[String] = []

func _ready() -> void:
	name = "ComputerUseInputFixture"
	queue_redraw()
	_build_ui()
	grab_focus()
	_emit_event("ready", {"message": "Godot input fixture is ready"})

func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, size), Color("16233a"))
	var grid_color := Color("2e496b")
	for x in range(0, int(size.x), 48):
		draw_line(Vector2(x, 0), Vector2(x, size.y), grid_color, 1.0)
	for y in range(0, int(size.y), 48):
		draw_line(Vector2(0, y), Vector2(size.x, y), grid_color, 1.0)

func _notification(what: int) -> void:
	if what == NOTIFICATION_RESIZED:
		queue_redraw()

func _build_ui() -> void:
	var margin := MarginContainer.new()
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	margin.add_theme_constant_override("margin_left", 24)
	margin.add_theme_constant_override("margin_right", 24)
	margin.add_theme_constant_override("margin_top", 20)
	margin.add_theme_constant_override("margin_bottom", 20)
	add_child(margin)

	var column := VBoxContainer.new()
	column.add_theme_constant_override("separation", 10)
	margin.add_child(column)

	var title := Label.new()
	title.text = "Computer-use Godot input fixture"
	title.add_theme_font_size_override("font_size", 26)
	column.add_child(title)

	var instructions := Label.new()
	instructions.text = "Click the window, type in the field, hold simultaneous keys, drag with a mouse button, or use the wheel. Every engine event is visible here and printed to stdout as __EVENT__ JSON."
	instructions.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	column.add_child(instructions)

	status_label = Label.new()
	status_label.text = "Awaiting input"
	status_label.add_theme_color_override("font_color", Color("9ed0ff"))
	column.add_child(status_label)

	input_line = LineEdit.new()
	input_line.placeholder_text = "Type fixture text here"
	input_line.tooltip_text = "Keyboard events remain visible in the event log."
	column.add_child(input_line)

	var reset_button := Button.new()
	reset_button.text = "Reset visible event state"
	reset_button.pressed.connect(_reset_visible_state)
	column.add_child(reset_button)

	var log_title := Label.new()
	log_title.text = "Visible event log"
	column.add_child(log_title)

	log_label = RichTextLabel.new()
	log_label.bbcode_enabled = false
	log_label.fit_content = false
	log_label.custom_minimum_size = Vector2(0, 300)
	log_label.size_flags_vertical = Control.SIZE_EXPAND_FILL
	column.add_child(log_label)

func _input(event: InputEvent) -> void:
	var details := _event_details(event)
	if details.is_empty():
		return
	_emit_event(str(details.action), details)

func _event_details(event: InputEvent) -> Dictionary:
	var details := {
		"window_size": {"x": get_window().size.x, "y": get_window().size.y},
		"content_scale": get_window().content_scale_factor,
	}

	if event is InputEventKey:
		var key_id := str(event.physical_keycode if event.physical_keycode != 0 else event.keycode)
		if event.pressed:
			held_keys[key_id] = OS.get_keycode_string(event.keycode)
		else:
			held_keys.erase(key_id)
		details.merge({
			"action": "key-down" if event.pressed else "key-up",
			"keycode": event.keycode,
			"physical_keycode": event.physical_keycode,
			"key": OS.get_keycode_string(event.keycode),
			"echo": event.echo,
		})
	elif event is InputEventMouseButton:
		var button_id := str(event.button_index)
		if event.pressed:
			held_buttons[button_id] = event.button_index
		else:
			held_buttons.erase(button_id)
		details.merge({
			"action": "scroll" if event.button_index >= MOUSE_BUTTON_WHEEL_UP else ("pointer-down" if event.pressed else "pointer-up"),
			"button": event.button_index,
			"pressed": event.pressed,
			"position": {"x": event.position.x, "y": event.position.y},
			"global_position": {"x": event.global_position.x, "y": event.global_position.y},
		})
	elif event is InputEventMouseMotion:
		details.merge({
			"action": "pointer-move",
			"position": {"x": event.position.x, "y": event.position.y},
			"relative": {"x": event.relative.x, "y": event.relative.y},
		})
	else:
		return {}

	details["held_keys"] = held_keys.values()
	details["held_buttons"] = held_buttons.values()
	return details

func _emit_event(action: String, details: Dictionary) -> void:
	event_index += 1
	var payload := details.duplicate(true)
	payload["fixture"] = "godot"
	payload["index"] = event_index
	payload["action"] = action
	payload["engine_event"] = true
	var line := JSON.stringify(payload)
	print("__EVENT__ ", line)
	log_lines.push_front(line)
	if log_lines.size() > 30:
		log_lines.pop_back()
	if status_label:
		status_label.text = "%s | held keys: %s | held buttons: %s" % [action, str(payload.get("held_keys", [])), str(payload.get("held_buttons", []))]
	if log_label:
		log_label.text = "\n".join(log_lines)

func _reset_visible_state() -> void:
	held_keys.clear()
	held_buttons.clear()
	log_lines.clear()
	if log_label:
		log_label.text = "Visible state reset; the reset click remains in stdout."
	_emit_event("reset", {"message": "Visible fixture state reset", "held_keys": [], "held_buttons": []})
