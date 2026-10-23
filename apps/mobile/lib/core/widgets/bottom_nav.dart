import 'package:flutter/material.dart';

/// Bottom navigation destinations for the main app shell.
enum LemonTab {
  discover(label: 'Discover', icon: Icons.explore_outlined, activeIcon: Icons.explore),
  likes(label: 'Likes', icon: Icons.favorite_border, activeIcon: Icons.favorite),
  chats(label: 'Chats', icon: Icons.chat_bubble_outline, activeIcon: Icons.chat_bubble),
  you(label: 'You', icon: Icons.person_outline, activeIcon: Icons.person);

  const LemonTab({
    required this.label,
    required this.icon,
    required this.activeIcon,
  });

  final String label;
  final IconData icon;
  final IconData activeIcon;
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
          label: tab.label,
        );
      }).toList(),
    );
  }
}
