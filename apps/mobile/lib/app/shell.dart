import 'package:flutter/material.dart';
import '../core/widgets/bottom_nav.dart';
import '../core/widgets/state_views.dart';
import '../core/theme/lemon_typography.dart';

/// Main app shell with bottom navigation.
///
/// Each tab maintains its own navigation state (placeholder screens for now).
class AppShell extends StatefulWidget {
  const AppShell({super.key});

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  LemonTab _currentTab = LemonTab.discover;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: _buildBody(),
      ),
      bottomNavigationBar: LemonBottomNav(
        currentTab: _currentTab,
        onTabSelected: (tab) => setState(() => _currentTab = tab),
      ),
    );
  }

  Widget _buildBody() {
    // Placeholder screens — replaced by real feature screens in later phases
    return switch (_currentTab) {
      LemonTab.discover => _PlaceholderScreen(title: 'Discover', icon: Icons.explore),
      LemonTab.likes => _PlaceholderScreen(title: 'Likes', icon: Icons.favorite),
      LemonTab.chats => _PlaceholderScreen(title: 'Chats', icon: Icons.chat_bubble),
      LemonTab.you => _PlaceholderScreen(title: 'You', icon: Icons.person),
    };
  }
}

class _PlaceholderScreen extends StatelessWidget {
  const _PlaceholderScreen({required this.title, required this.icon});
  final String title;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(16),
          child: Text(title, style: LemonTypography.title),
        ),
        Expanded(
          child: LemonEmptyView(
            message: '$title will be available soon.',
            icon: icon,
          ),
        ),
      ],
    );
  }
}
