/// Client-side birth date checks for the adult gate.
///
/// These give immediate feedback only. The server calculates adult
/// eligibility from the saved date (UTC day boundary) and is the authority;
/// a server `AGE_INELIGIBLE` response always wins.
library;

const int minimumAge = 18;

enum BirthDateError { required, future, underage }

/// Whole years between [birthDate] and [today], matching the server policy:
/// a 29 February birthday is reached on 1 March in non-leap years.
int ageOn(DateTime birthDate, DateTime today) {
  var age = today.year - birthDate.year;
  final beforeBirthday =
      today.month < birthDate.month ||
      (today.month == birthDate.month && today.day < birthDate.day);
  if (beforeBirthday) age--;
  return age;
}

BirthDateError? validateBirthDate(DateTime? birthDate, DateTime today) {
  if (birthDate == null) return BirthDateError.required;
  final day = DateTime(birthDate.year, birthDate.month, birthDate.day);
  final todayDay = DateTime(today.year, today.month, today.day);
  if (day.isAfter(todayDay)) return BirthDateError.future;
  if (ageOn(day, todayDay) < minimumAge) return BirthDateError.underage;
  return null;
}

/// Date-only ISO string (`YYYY-MM-DD`), with no time zone conversion.
String isoDate(DateTime date) {
  String two(int n) => n.toString().padLeft(2, '0');
  return '${date.year.toString().padLeft(4, '0')}-${two(date.month)}-'
      '${two(date.day)}';
}

/// Parses a `YYYY-MM-DD` string as a local calendar date.
DateTime? parseIsoDate(String? value) {
  if (value == null) return null;
  final match = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(value);
  if (match == null) return null;
  return DateTime(
    int.parse(match.group(1)!),
    int.parse(match.group(2)!),
    int.parse(match.group(3)!),
  );
}
