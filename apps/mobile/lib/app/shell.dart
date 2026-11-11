import 'package:flutter/material.dart';

import '../core/l10n/l10n.dart';
import '../core/theme/lemon_typography.dart';
import '../core/widgets/bottom_nav.dart';
import '../core/widgets/state_views.dart';
import '../features/profile/ui/you_screen.dart';

/// Main app shell with bottom navigation.
///
/// Discover, Likes and Chats are placeholders until their phases land.
class AppShell extends StatefulWidget {
  const AppShell({super.key, this.initialTab = LemonTab.discover});

  final LemonTab initialTab;

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  late LemonTab _currentTab = widget.initialTab;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(child: _buildBody(context)),
      bottomNavigationBar: LemonBottomNav(
        currentTab: _currentTab,
        onTabSelected: (tab) => setState(() => _currentTab = tab),
      ),
    );
  }

  Widget _buildBody(BuildContext context) {
    return switch (_currentTab) {
      LemonTab.discover => _PlaceholderScreen(
        tab: LemonTab.discover,
        icon: Icons.explore,
      ),
      LemonTab.likes => _PlaceholderScreen(
        tab: LemonTab.likes,
        icon: Icons.favorite,
      ),
      LemonTab.chats => _PlaceholderScreen(
        tab: LemonTab.chats,
        icon: Icons.chat_bubble,
      ),
      LemonTab.you => const YouScreen(),
    };
  }
}

class _PlaceholderScreen extends StatelessWidget {
  const _PlaceholderScreen({required this.tab, required this.icon});

  final LemonTab tab;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final title = tab.label(context.l10n);
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(16),
          child: Text(title, style: LemonTypography.title),
        ),
        Expanded(
          child: LemonEmptyView(
            message: context.l10n.navComingSoon(title),
            icon: icon,
          ),
        ),
      ],
    );
  }
}
