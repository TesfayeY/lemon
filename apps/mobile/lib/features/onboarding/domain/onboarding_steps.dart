import '../data/account.dart';

/// Onboarding screens in order. Each saves to the server before moving on,
/// so onboarding resumes on any device from the server's readiness list.
enum OnboardingStep {
  verifyEmail,
  birthDate,
  terms,
  basics,
  location,
  preferences,
  photos,
  prompts,
  about,
  readiness,
}

/// The step that collects each readiness requirement.
OnboardingStep? stepFor(ReadinessRequirement requirement) =>
    switch (requirement) {
      ReadinessRequirement.emailVerified => OnboardingStep.verifyEmail,
      ReadinessRequirement.adultEligible => OnboardingStep.birthDate,
      ReadinessRequirement.termsAccepted => OnboardingStep.terms,
      ReadinessRequirement.displayName ||
      ReadinessRequirement.genderIdentity ||
      ReadinessRequirement.intention => OnboardingStep.basics,
      ReadinessRequirement.location => OnboardingStep.location,
      ReadinessRequirement.interests => OnboardingStep.preferences,
      ReadinessRequirement.photos => OnboardingStep.photos,
      ReadinessRequirement.promptAnswers => OnboardingStep.prompts,
      // Not something a person can fix in onboarding
      ReadinessRequirement.accountSuspended ||
      ReadinessRequirement.unknown => null,
    };

/// Steps shown for this account. Email verification only appears while the
/// server still reports it missing.
List<OnboardingStep> visibleSteps(Readiness readiness) => [
  for (final step in OnboardingStep.values)
    if (step != OnboardingStep.verifyEmail ||
        readiness.missing.contains(ReadinessRequirement.emailVerified))
      step,
];

/// Where to resume: the earliest step with a missing requirement, else the
/// readiness summary. Photos and prompts can stay "missing" while they wait
/// for review; the person sees that state on those steps.
OnboardingStep resumeStep(Readiness readiness) {
  OnboardingStep? earliest;
  for (final requirement in readiness.missing) {
    final step = stepFor(requirement);
    if (step == null) continue;
    if (earliest == null || step.index < earliest.index) earliest = step;
  }
  return earliest ?? OnboardingStep.readiness;
}
