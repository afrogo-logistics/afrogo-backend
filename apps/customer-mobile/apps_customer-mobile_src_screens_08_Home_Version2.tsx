import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { tokens } from '../theme/tokens';
import { GlassCard } from '../components/GlassCard';
import { CTAButton } from '../components/CTAButton';
import { MapCard } from '../components/MapCard';
import { BottomNav } from '../components/BottomNav';
import { api } from '../api/client';
import { useNavigation } from '@react-navigation/native';

const Home: React.FC = () => {
  const [points, setPoints] = useState<any[]>([]);
  const [nextShipment, setNextShipment] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const nav = useNavigation();

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const p = await api.points();
        const s = await api.shipments('status=ACTIVE&limit=1');
        if (!mounted) return;
        setPoints(Array.isArray(p) ? p.slice(0, 4) : []);
        setNextShipment((s as any)?.items?.[0] ?? null);
      } catch (err) {
        // TODO: show toast / error state
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const handleSend = () => nav.navigate('SendStep1' as never);
  const handleTrack = () => nav.navigate('Shipments' as never);
  const handlePoints = () => nav.navigate('Points' as never);

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity accessibilityLabel="Open menu">
            <Text style={styles.hamburger}>☰</Text>
          </TouchableOpacity>

          {/* You can swap this Text for an <Image> logo when ready */}
          <Text style={styles.logo}>AfroGo</Text>

          <TouchableOpacity
            style={styles.bellChip}
            accessibilityLabel="Open notifications"
            onPress={() => nav.navigate('Notifications' as never)}
          >
            <Text style={styles.bellIcon}>🔔</Text>
          </TouchableOpacity>
        </View>

        {/* Hero: AfroGo Points near you */}
        <GlassCard radius="lg" style={styles.heroCard}>
          <Text style={styles.heroTitle}>AfroGo Points near you</Text>
          <View style={styles.heroMapWrapper}>
            <MapCard height={140} points={points} />
          </View>
        </GlassCard>

        {/* Primary CTAs */}
        <View style={styles.ctaRow}>
          <GlassCard style={styles.ctaCard}>
            <CTAButton
              label="Send a Parcel"
              variant="tile"
              icon="box"
              onPress={handleSend}
            />
          </GlassCard>
          <GlassCard style={styles.ctaCard}>
            <CTAButton
              label="Track a Parcel"
              variant="tile"
              icon="search"
              onPress={handleTrack}
            />
          </GlassCard>
          <GlassCard style={styles.ctaCard}>
            <CTAButton
              label="Find AfroGo Point"
              variant="tile"
              icon="pin"
              onPress={handlePoints}
            />
          </GlassCard>
        </View>

        {/* Next shipment */}
        <GlassCard radius="lg" style={styles.nextCard}>
          {loading ? (
            <ActivityIndicator color={tokens.colors.accentRed} />
          ) : nextShipment ? (
            <View style={styles.nextContent}>
              <View style={{ flex: 1 }}>
                <Text style={styles.smallLabel}>NEXT SHIPMENT</Text>
                <Text style={styles.nextTitle}>
                  {nextShipment.statusLabel ?? 'Out for delivery'}
                </Text>
                <Text style={styles.nextSubtitle}>
                  {nextShipment.etaWindow ?? 'Today, 14:00–16:00'}
                </Text>
              </View>
              <View style={styles.nextMapWrapper}>
                <MapCard
                  height={80}
                  compact
                  route={nextShipment.route}
                />
              </View>
            </View>
          ) : (
            <>
              <Text style={styles.smallLabel}>NEXT SHIPMENT</Text>
              <Text style={styles.nextEmptyTitle}>No parcels yet</Text>
              <Text style={styles.nextSubtitle}>
                Send your first parcel to see it here.
              </Text>
            </>
          )}
        </GlassCard>

        {/* Promo row */}
        <View style={styles.promoRow}>
          <GlassCard style={styles.promoCard}>
            <Text style={styles.promoTitle}>What is</Text>
            <Text style={styles.promoHighlight}>AfroCollect?</Text>
          </GlassCard>
          <GlassCard style={styles.promoCard}>
            <Text style={styles.promoTitle}>How</Text>
            <Text style={styles.promoHighlight}>AfroGo works</Text>
          </GlassCard>
          <GlassCard style={styles.promoCard}>
            <Text style={styles.promoTitle}>Become</Text>
            <Text style={styles.promoHighlight}>a driver</Text>
          </GlassCard>
        </View>
      </ScrollView>

      <BottomNav active="Home" />
    </View>
  );
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.colors.bgStart },
  container: {
    padding: tokens.spacing.md,
    paddingBottom: 120,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  hamburger: {
    color: tokens.colors.textPrimary,
    fontSize: 24,
  },
  logo: {
    color: tokens.colors.textPrimary,
    fontSize: 24,
    fontWeight: '700',
  },
  bellChip: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: tokens.colors.accentRed,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellIcon: {
    fontSize: 18,
  },

  heroCard: { marginTop: tokens.spacing.lg },
  heroTitle: {
    color: tokens.colors.textPrimary,
    fontSize: tokens.typography.h2,
    fontWeight: '600',
  },
  heroMapWrapper: {
    height: 140,
    marginTop: tokens.spacing.sm,
    overflow: 'hidden',
    borderRadius: tokens.radius.lg,
  },

  ctaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: tokens.spacing.lg,
  },
  ctaCard: {
    width: '30%',
    alignItems: 'center',
    paddingVertical: tokens.spacing.sm,
  },

  nextCard: {
    marginTop: tokens.spacing.lg,
    padding: tokens.spacing.md,
  },
  nextContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  smallLabel: {
    color: tokens.colors.textSecondary,
    letterSpacing: 1.2,
    fontSize: 12,
  },
  nextTitle: {
    color: tokens.colors.textPrimary,
    fontSize: 20,
    fontWeight: '700',
    marginTop: 6,
  },
  nextEmptyTitle: {
    color: tokens.colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    marginTop: 6,
  },
  nextSubtitle: {
    color: tokens.colors.textSecondary,
    marginTop: 4,
  },
  nextMapWrapper: {
    width: 120,
    height: 80,
    marginLeft: tokens.spacing.md,
    borderRadius: tokens.radius.md,
    overflow: 'hidden',
  },

  promoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: tokens.spacing.lg,
    marginBottom: tokens.spacing.lg,
  },
  promoCard: {
    width: '30%',
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.xs,
    justifyContent: 'center',
  },
  promoTitle: {
    color: tokens.colors.textSecondary,
    fontSize: 12,
  },
  promoHighlight: {
    color: tokens.colors.textPrimary,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 2,
  },
});

export default Home;