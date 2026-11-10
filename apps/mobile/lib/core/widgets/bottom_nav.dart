import 'package:flutter/material.dart';

import '../l10n/l10n.dart';

/// Bottom navigation destinations for the main app shell.
enum LemonTab {
  discover(icon: Icons.explore_outlined, activeIcon: Icons.explore),
  likes(icon: Icons.favorite_border, activeIcon: Icons.favorite),
  chats(icon: Icons.chat_bubble_outline, activeIcon: Icons.chat_bubble),
  you(icon: Icons.person_outline, activeIcon: Icons.person);

  const LemonTab({required this.icon, required this.activeIcon});

  final IconData icon;
  final IconData activeIcon;

  /// Localized destination label.
  String label(AppLocalizations l10n) => switch (this) {
    LemonTab.discover => l10n.navDiscover,
    LemonTab.likes => l10n.navLikes,
    LemonTab.chats => l10n.navChats,
    LemonTab.you => l10n.navYou,
  };
}

/// Main app navigation bar with four destinations.
class LemonBottomNav extends StatelessWidget {
  const LemonBottomNav({
    super.key,
    required this.currentTab,
    required this.onTabSelected,
    this.badges = const {},
  });

  final LemonTab currentTab;
  final ValueChanged<LemonTab> onTabSelected;

  /// Badge counts per tab (e.g., unread likes, messages).
  final Map<LemonTab, int> badges;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return NavigationBar(
      selectedIndex: currentTab.index,
      onDestinationSelected: (i) => onTabSelected(LemonTab.values[i]),
      destinations: LemonTab.values.map((tab) {
        final badge = badges[tab] ?? 0;
        return NavigationDestination(
          icon: badge > 0
              ? Badge.count(count: badge, child: Icon(tab.icon))
              : Icon(tab.icon),
          selectedIcon: badge > 0
              ? Badge.count(count: badge, child: Icon(tab.activeIcon))
              : Icon(tab.activeIcon),
          label: tab.label(l10n),
        );
      }).toList(),
    );
  }
}
