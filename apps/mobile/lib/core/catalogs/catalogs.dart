/// Static catalogs from `GET /v1/catalogs`. IDs are stable; labels are display text.
class Catalogs {
  const Catalogs({
    required this.states,
    required this.cities,
    required this.prompts,
    required this.intentions,
    required this.genderCategories,
    required this.languages,
  });

  factory Catalogs.fromJson(Map<String, dynamic> json) => Catalogs(
    states: _list(json['states'], UsState.fromJson),
    cities: _list(json['cities'], City.fromJson),
    prompts: _list(json['prompts'], PromptCatalogItem.fromJson),
    intentions: _list(json['intentions'], CatalogOption.fromJson),
    genderCategories: _list(json['genderCategories'], CatalogOption.fromJson),
    languages: _list(json['languages'], CatalogOption.fromJson),
  );

  final List<UsState> states;
  final List<City> cities;
  final List<PromptCatalogItem> prompts;
  final List<CatalogOption> intentions;
  final List<CatalogOption> genderCategories;
  final List<CatalogOption> languages;

  Map<String, dynamic> toJson() => {
    'states': states.map((s) => s.toJson()).toList(),
    'cities': cities.map((c) => c.toJson()).toList(),
    'prompts': prompts.map((p) => p.toJson()).toList(),
    'intentions': intentions.map((i) => i.toJson()).toList(),
    'genderCategories': genderCategories.map((g) => g.toJson()).toList(),
    'languages': languages.map((l) => l.toJson()).toList(),
  };
}

List<T> _list<T>(Object? json, T Function(Map<String, dynamic>) fromJson) =>
    (json as List<dynamic>)
        .map((e) => fromJson(e as Map<String, dynamic>))
        .toList();

class CatalogOption {
  const CatalogOption({required this.id, required this.label});

  factory CatalogOption.fromJson(Map<String, dynamic> json) =>
      CatalogOption(id: json['id'] as String, label: json['label'] as String);

  final String id;
  final String label;

  Map<String, dynamic> toJson() => {'id': id, 'label': label};
}

class UsState {
  const UsState({required this.code, required this.name});

  factory UsState.fromJson(Map<String, dynamic> json) =>
      UsState(code: json['code'] as String, name: json['name'] as String);

  final String code;
  final String name;

  Map<String, dynamic> toJson() => {'code': code, 'name': name};
}

/// A US city of residence. Same-named cities in different states have distinct IDs.
class City {
  const City({
    required this.id,
    required this.name,
    required this.stateCode,
    required this.countryCode,
  });

  factory City.fromJson(Map<String, dynamic> json) => City(
    id: json['id'] as String,
    name: json['name'] as String,
    stateCode: json['stateCode'] as String,
    countryCode: json['countryCode'] as String,
  );

  final String id;
  final String name;
  final String stateCode;
  final String countryCode;

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'stateCode': stateCode,
    'countryCode': countryCode,
  };
}

class PromptCatalogItem {
  const PromptCatalogItem({
    required this.id,
    required this.category,
    required this.text,
    required this.active,
  });

  factory PromptCatalogItem.fromJson(Map<String, dynamic> json) =>
      PromptCatalogItem(
        id: json['id'] as String,
        category: json['category'] as String,
        text: json['text'] as String,
        active: json['active'] as bool,
      );

  final String id;
  final String category;
  final String text;
  final bool active;

  Map<String, dynamic> toJson() => {
    'id': id,
    'category': category,
    'text': text,
    'active': active,
  };
}
