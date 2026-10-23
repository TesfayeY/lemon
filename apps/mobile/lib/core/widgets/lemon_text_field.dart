import 'package:flutter/material.dart';

/// Themed text input with label, error, and password toggle.
class LemonTextField extends StatefulWidget {
  const LemonTextField({
    super.key,
    required this.label,
    this.controller,
    this.errorText,
    this.obscureText = false,
    this.keyboardType,
    this.maxLength,
    this.maxLines = 1,
    this.onChanged,
    this.autofillHints,
  });

  final String label;
  final TextEditingController? controller;
  final String? errorText;
  final bool obscureText;
  final TextInputType? keyboardType;
  final int? maxLength;
  final int maxLines;
  final ValueChanged<String>? onChanged;
  final Iterable<String>? autofillHints;

  @override
  State<LemonTextField> createState() => _LemonTextFieldState();
}

class _LemonTextFieldState extends State<LemonTextField> {
  late bool _obscured;

  @override
  void initState() {
    super.initState();
    _obscured = widget.obscureText;
  }

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: widget.controller,
      obscureText: _obscured,
      keyboardType: widget.keyboardType,
      maxLength: widget.maxLength,
      maxLines: widget.maxLines,
      onChanged: widget.onChanged,
      autofillHints: widget.autofillHints,
      decoration: InputDecoration(
        labelText: widget.label,
        errorText: widget.errorText,
        suffixIcon: widget.obscureText
            ? IconButton(
                icon: Icon(
                  _obscured ? Icons.visibility_off : Icons.visibility,
                  semanticLabel:
                      _obscured ? 'Show password' : 'Hide password',
                ),
                onPressed: () => setState(() => _obscured = !_obscured),
              )
            : null,
      ),
    );
  }
}
