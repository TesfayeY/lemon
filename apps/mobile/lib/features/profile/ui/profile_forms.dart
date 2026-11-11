import 'package:flutter/material.dart';

import '../../../app/config.dart';
import '../../../core/catalogs/catalogs.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/theme/lemon_colors.dart';
import '../../../core/theme/lemon_spacing.dart';
import '../../../core/theme/lemon_typography.dart';
import '../../../core/widgets/inline_message.dart';
import '../data/preferences.dart';
import '../data/profile.dart';
import '../domain/validation.dart';
import 'form_host.dart';

List<({String id, String label})> _options(List<CatalogOption> catalog) => [
  for (final option in catalog) (id: option.id, label: option.label),
];

String _visibility(bool isPublic) =>
    isPublic ? FieldVisibility.public.wire : FieldVisibility.private.wire;

/// "Seattle, WA" style label for a catalog city.
String cityLabel(AppLocalizations l10n, City city) =>
    l10n.cityState(city.name, city.stateCode);

/// Name, gender (with visibility) and relationship intention.
class BasicsForm extends StatefulWidget {
  const BasicsForm({
    super.key,
    required this.profile,
    required this.catalogs,
    this.serverErrors = const {},
  });

  final SelfProfile profile;
  final Catalogs catalogs;
  final Set<String> serverErrors;

  @override
  State<BasicsForm> createState() => _BasicsFormState();
}

class _BasicsFormState extends SectionFormState<BasicsForm> {
  late final _name = TextEditingController(text: widget.profile.displayName);
  late String? _gender = widget.profile.genderIdentity;
  late bool _genderPublic =
      widget.profile.genderDisplay == FieldVisibility.public;
  late String? _intention = widget.profile.intention;
  bool _attempted = false;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  @override
  Map<String, Object?>? collect() {
    setState(() => _attempted = true);
    final nameError = validateRequiredText(
      _name.text,
      max: ProfileLimits.displayNameMax,
    );
    if (nameError != null || _gender == null || _intention == null) {
      return null;
    }
    return {
      'displayName': normalizeWhitespace(_name.text),
      'genderIdentity': _gender,
      'genderDisplay': _visibility(_genderPublic),
      'intention': _intention,
    };
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final nameError = !_attempted
        ? null
        : switch (validateRequiredText(
            _name.text,
            max: ProfileLimits.displayNameMax,
          )) {
            TextError.required => l10n.nameRequired,
            TextError.tooLong => l10n.commonTextTooLong(
              ProfileLimits.displayNameMax,
            ),
            null =>
              widget.serverErrors.contains('displayName')
                  ? l10n.errorValidation
                  : null,
          };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: LemonSpacing.lg),
          child: TextField(
            controller: _name,
            textCapitalization: TextCapitalization.words,
            autofillHints: const [AutofillHints.givenName],
            maxLength: ProfileLimits.displayNameMax,
            textInputAction: TextInputAction.done,
            onChanged: (_) {
              if (_attempted) setState(() {});
            },
            decoration: InputDecoration(
              labelText: l10n.nameLabel,
              helperText: l10n.nameHelp(appName),
              helperMaxLines: 3,
              errorText: nameError,
              errorMaxLines: 3,
            ),
          ),
        ),
        FieldGroup(
          label: l10n.genderLabel,
          error: _attempted && _gender == null ? l10n.genderRequired : null,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SingleChoiceChips(
                options: _options(widget.catalogs.genderCategories),
                selected: _gender,
                onSelected: (id) => setState(() => _gender = id),
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(l10n.genderShow),
                value: _genderPublic,
                onChanged: (value) => setState(() => _genderPublic = value),
              ),
            ],
          ),
        ),
        FieldGroup(
          label: l10n.intentionLabel,
          error: _attempted && _intention == null
              ? l10n.intentionRequired
              : null,
          child: SingleChoiceChips(
            options: _options(widget.catalogs.intentions),
            selected: _intention,
            onSelected: (id) => setState(() => _intention = id),
          ),
        ),
      ],
    );
  }
}

/// US city of residence, chosen from the catalog by search. There is no
/// free-text or global country entry.
class LocationForm extends StatefulWidget {
  const LocationForm({
    super.key,
    required this.profile,
    required this.catalogs,
    this.serverErrors = const {},
  });

  final SelfProfile profile;
  final Catalogs catalogs;
  final Set<String> serverErrors;

  @override
  State<LocationForm> createState() => _LocationFormState();
}

class _LocationFormState extends SectionFormState<LocationForm> {
  final _search = TextEditingController();
  late String? _cityId = widget.profile.cityId;
  bool _attempted = false;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Map<String, Object?>? collect() {
    setState(() => _attempted = true);
    if (_cityId == null) return null;
    return {'cityId': _cityId};
  }

  List<City> _matches() {
    final query = _search.text.trim().toLowerCase();
    final stateNames = {
      for (final s in widget.catalogs.states) s.code: s.name.toLowerCase(),
    };
    final cities = [...widget.catalogs.cities]
      ..sort((a, b) {
        final byName = a.name.compareTo(b.name);
        return byName != 0 ? byName : a.stateCode.compareTo(b.stateCode);
      });
    if (query.isEmpty) return cities;
    return cities
        .where(
          (c) =>
              c.name.toLowerCase().contains(query) ||
              c.stateCode.toLowerCase() == query ||
              (stateNames[c.stateCode]?.contains(query) ?? false) ||
              '${c.name}, ${c.stateCode}'.toLowerCase().contains(query),
        )
        .toList();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    City? selected;
    for (final city in widget.catalogs.cities) {
      if (city.id == _cityId) selected = city;
    }
    final matches = _matches();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (selected != null) ...[
          InlineMessage(
            message: l10n.locationSelected(cityLabel(l10n, selected)),
            tone: MessageTone.success,
          ),
          const SizedBox(height: LemonSpacing.base),
        ],
        TextField(
          controller: _search,
          textInputAction: TextInputAction.search,
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(
            labelText: l10n.locationSearch,
            prefixIcon: const Icon(Icons.search),
          ),
        ),
        const SizedBox(height: LemonSpacing.sm),
        if (matches.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: LemonSpacing.base),
            child: InlineMessage(message: l10n.locationNoResults),
          ),
        for (final city in matches.take(30))
          Semantics(
            selected: city.id == _cityId,
            inMutuallyExclusiveGroup: true,
            child: ListTile(
              contentPadding: EdgeInsets.zero,
              minTileHeight: LemonSize.touchTarget,
              title: Text(cityLabel(l10n, city)),
              trailing: city.id == _cityId
                  ? const Icon(Icons.check_circle, color: LemonColors.primary)
                  : null,
              onTap: () => setState(() => _cityId = city.id),
            ),
          ),
        if (_attempted && _cityId == null)
          InlineMessage(message: l10n.locationRequired, tone: MessageTone.error),
        if (widget.serverErrors.contains('cityId'))
          InlineMessage(message: l10n.errorValidation, tone: MessageTone.error),
      ],
    );
  }
}

/// Optional details with per-field visibility. Sensitive fields (P-03) only
/// appear when [showSensitiveFields] is on.
class AboutForm extends StatefulWidget {
  const AboutForm({
    super.key,
    required this.profile,
    required this.catalogs,
    required this.showSensitiveFields,
    this.serverErrors = const {},
  });

  final SelfProfile profile;
  final Catalogs catalogs;
  final bool showSensitiveFields;
  final Set<String> serverErrors;

  @override
  State<AboutForm> createState() => _AboutFormState();
}

class _AboutFormState extends SectionFormState<AboutForm> {
  late final _bio = TextEditingController(text: widget.profile.bio);
  late final _hometown = TextEditingController(text: widget.profile.hometown);
  late final _occupation = TextEditingController(
    text: widget.profile.occupation,
  );
  late final _education = TextEditingController(text: widget.profile.education);
  late final _religion = TextEditingController(text: widget.profile.religion);
  late bool _hometownPublic = _isPublic(widget.profile.hometownDisplay);
  late bool _occupationPublic = _isPublic(widget.profile.occupationDisplay);
  late bool _educationPublic = _isPublic(widget.profile.educationDisplay);
  late bool _heightPublic = _isPublic(widget.profile.heightDisplay);
  late bool _languagesPublic = _isPublic(widget.profile.languagesDisplay);
  late bool _religionPublic = _isPublic(widget.profile.religionDisplay);
  late int? _height = widget.profile.height;
  late Set<String> _languages = {...widget.profile.languages};

  static bool _isPublic(FieldVisibility v) => v == FieldVisibility.public;

  @override
  void dispose() {
    for (final c in [_bio, _hometown, _occupation, _education, _religion]) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Map<String, Object?>? collect() {
    final tooLong =
        validateOptionalText(_bio.text, max: ProfileLimits.bioMax) != null ||
        [_hometown, _occupation, _education, _religion].any(
          (c) =>
              validateOptionalText(c.text, max: ProfileLimits.optionalTextMax) !=
              null,
        );
    if (tooLong) {
      setState(() {});
      return null;
    }
    // Keep the saved order; catalog IDs the client does not know are kept too
    final languages = [
      for (final id in widget.profile.languages)
        if (_languages.contains(id)) id,
      for (final option in widget.catalogs.languages)
        if (_languages.contains(option.id) &&
            !widget.profile.languages.contains(option.id))
          option.id,
    ];
    return {
      'bio': optionalTextValue(_bio.text),
      'hometown': optionalTextValue(_hometown.text),
      'hometownDisplay': _visibility(_hometownPublic),
      'occupation': optionalTextValue(_occupation.text),
      'occupationDisplay': _visibility(_occupationPublic),
      'education': optionalTextValue(_education.text),
      'educationDisplay': _visibility(_educationPublic),
      'height': _height,
      'heightDisplay': _visibility(_heightPublic),
      'languages': languages,
      'languagesDisplay': _visibility(_languagesPublic),
      if (widget.showSensitiveFields) ...{
        'religion': optionalTextValue(_religion.text),
        'religionDisplay': _visibility(_religionPublic),
      },
    };
  }

  Widget _textField({
    required TextEditingController controller,
    required String label,
    required String field,
    required int max,
    int maxLines = 1,
  }) {
    final l10n = context.l10n;
    final tooLong = validateOptionalText(controller.text, max: max) != null;
    return TextField(
      controller: controller,
      maxLength: max,
      maxLines: maxLines,
      minLines: 1,
      textCapitalization: TextCapitalization.sentences,
      onChanged: (_) => setState(() {}),
      decoration: InputDecoration(
        labelText: label,
        errorMaxLines: 3,
        errorText: tooLong
            ? l10n.commonTextTooLong(max)
            : widget.serverErrors.contains(field)
            ? l10n.errorValidation
            : null,
      ),
    );
  }

  Widget _visibilitySwitch(bool value, ValueChanged<bool> onChanged) =>
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: Text(context.l10n.commonShowOnProfile),
        value: value,
        onChanged: onChanged,
      );

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _textField(
          controller: _bio,
          label: l10n.bioLabel,
          field: 'bio',
          max: ProfileLimits.bioMax,
          maxLines: 6,
        ),
        const SizedBox(height: LemonSpacing.base),
        _textField(
          controller: _hometown,
          label: l10n.hometownLabel,
          field: 'hometown',
          max: ProfileLimits.optionalTextMax,
        ),
        _visibilitySwitch(
          _hometownPublic,
          (v) => setState(() => _hometownPublic = v),
        ),
        const SizedBox(height: LemonSpacing.sm),
        _textField(
          controller: _occupation,
          label: l10n.occupationLabel,
          field: 'occupation',
          max: ProfileLimits.optionalTextMax,
        ),
        _visibilitySwitch(
          _occupationPublic,
          (v) => setState(() => _occupationPublic = v),
        ),
        const SizedBox(height: LemonSpacing.sm),
        _textField(
          controller: _education,
          label: l10n.educationLabel,
          field: 'education',
          max: ProfileLimits.optionalTextMax,
        ),
        _visibilitySwitch(
          _educationPublic,
          (v) => setState(() => _educationPublic = v),
        ),
        const SizedBox(height: LemonSpacing.sm),
        DropdownButtonFormField<int?>(
          initialValue: _height,
          isExpanded: true,
          decoration: InputDecoration(labelText: l10n.heightLabel),
          items: [
            DropdownMenuItem<int?>(child: Text(l10n.heightNotSet)),
            for (
              var cm = ProfileLimits.minHeightCm;
              cm <= ProfileLimits.maxHeightCm;
              cm++
            )
              DropdownMenuItem<int?>(value: cm, child: Text(heightLabel(l10n, cm))),
          ],
          onChanged: (value) => setState(() => _height = value),
        ),
        _visibilitySwitch(
          _heightPublic,
          (v) => setState(() => _heightPublic = v),
        ),
        const SizedBox(height: LemonSpacing.base),
        FieldGroup(
          label: l10n.languagesLabel,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              MultiChoiceChips(
                options: _options(widget.catalogs.languages),
                selected: _languages,
                onChanged: (value) => setState(() => _languages = value),
              ),
              _visibilitySwitch(
                _languagesPublic,
                (v) => setState(() => _languagesPublic = v),
              ),
            ],
          ),
        ),
        if (widget.showSensitiveFields) ...[
          _textField(
            controller: _religion,
            label: l10n.religionLabel,
            field: 'religion',
            max: ProfileLimits.optionalTextMax,
          ),
          _visibilitySwitch(
            _religionPublic,
            (v) => setState(() => _religionPublic = v),
          ),
        ],
      ],
    );
  }
}

/// "5′ 5″ (165 cm)".
String heightLabel(AppLocalizations l10n, int centimeters) {
  final (:feet, :inches) = feetAndInches(centimeters);
  return l10n.heightValue(feet, inches, centimeters);
}

/// Who the person wants to meet, age range, location scope and long distance.
class PreferencesForm extends StatefulWidget {
  const PreferencesForm({
    super.key,
    required this.preferences,
    required this.catalogs,
    this.serverErrors = const {},
  });

  final Preferences preferences;
  final Catalogs catalogs;
  final Set<String> serverErrors;

  @override
  State<PreferencesForm> createState() => _PreferencesFormState();
}

class _PreferencesFormState extends SectionFormState<PreferencesForm> {
  late Set<String> _interests = {
    ...widget.preferences.acceptedGenderCategories,
  };
  late RangeValues _ages = RangeValues(
    widget.preferences.minAge.toDouble(),
    widget.preferences.maxAge.toDouble(),
  );
  late LocationScope _scope = widget.preferences.locationScope;
  late bool _longDistance = widget.preferences.longDistance;
  bool _attempted = false;

  @override
  Map<String, Object?>? collect() {
    setState(() => _attempted = true);
    if (_interests.isEmpty) return null;
    final ordered = [
      for (final option in widget.catalogs.genderCategories)
        if (_interests.contains(option.id)) option.id,
      // Keep IDs this build does not know about
      for (final id in widget.preferences.acceptedGenderCategories)
        if (_interests.contains(id) &&
            !widget.catalogs.genderCategories.any((o) => o.id == id))
          id,
    ];
    final saved = widget.preferences.acceptedGenderCategories;
    final sameSet =
        saved.length == ordered.length && saved.every(ordered.contains);
    return {
      // Unchanged selections keep the saved order so nothing is resent
      'acceptedGenderCategories': sameSet ? saved : ordered,
      'minAge': _ages.start.round(),
      'maxAge': _ages.end.round(),
      'locationScope': _scope.wire,
      'longDistance': _longDistance,
    };
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final min = _ages.start.round();
    final max = _ages.end.round();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        FieldGroup(
          label: l10n.interestsLabel,
          help: l10n.interestsHelp,
          error: _attempted && _interests.isEmpty
              ? l10n.interestsRequired
              : null,
          child: MultiChoiceChips(
            options: _options(widget.catalogs.genderCategories),
            selected: _interests,
            onChanged: (value) => setState(() => _interests = value),
          ),
        ),
        FieldGroup(
          label: l10n.ageRangeLabel,
          error:
              widget.serverErrors.contains('minAge') ||
                  widget.serverErrors.contains('maxAge')
              ? l10n.errorValidation
              : null,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(l10n.ageRangeValue(min, max), style: LemonTypography.body),
              RangeSlider(
                values: _ages,
                min: ProfileLimits.minAge.toDouble(),
                max: ProfileLimits.maxAge.toDouble(),
                divisions: ProfileLimits.maxAge - ProfileLimits.minAge,
                labels: RangeLabels('$min', '$max'),
                semanticFormatterCallback: (value) => '${value.round()}',
                onChanged: (values) => setState(() => _ages = values),
              ),
            ],
          ),
        ),
        FieldGroup(
          label: l10n.scopeLabel,
          help: l10n.scopeMutualNote,
          child: RadioGroup<LocationScope>(
            groupValue: _scope,
            onChanged: (value) {
              if (value != null) setState(() => _scope = value);
            },
            child: Column(
              children: [
                for (final scope in LocationScope.values)
                  RadioListTile<LocationScope>(
                    contentPadding: EdgeInsets.zero,
                    value: scope,
                    title: Text(switch (scope) {
                      LocationScope.city => l10n.scopeCity,
                      LocationScope.state => l10n.scopeState,
                      LocationScope.nationwide => l10n.scopeNationwide,
                    }),
                    subtitle: Text(switch (scope) {
                      LocationScope.city => l10n.scopeCityHelp,
                      LocationScope.state => l10n.scopeStateHelp,
                      LocationScope.nationwide => l10n.scopeNationwideHelp(
                        appName,
                      ),
                    }),
                  ),
              ],
            ),
          ),
        ),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(l10n.longDistanceLabel),
          subtitle: Text(l10n.longDistanceHelp),
          value: _longDistance,
          onChanged: (value) => setState(() => _longDistance = value),
        ),
      ],
    );
  }
}
