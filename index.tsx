import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
} from 'react';
import {
  Animated,
  View,
  PanResponder,
  StyleSheet,
  LayoutChangeEvent,
  useWindowDimensions,
  Keyboard,
} from 'react-native';
import {
  DEFAULT_ANIMATION,
  DEFAULT_BACKDROP_MASK_COLOR,
  DEFAULT_HEIGHT,
} from './constant';
import {BottomSheetProps} from './index.d';
import DefaultHandleBar from './components/DefaultHandleBar';
import Container from './components/Container';
import normalizeHeight from './utils/normalizeHeight';
import convertHeight from './utils/convertHeight';
import useHandleKeyboardEvents from './hooks/useHandleKeyboardEvents';
import useAnimatedValue from './hooks/useAnimatedValue';
import Backdrop from './components/Backdrop';

/**
 * Supported animation types
 */
export enum ANIMATIONS {
  SLIDE = 'slide',
  SPRING = 'spring',
  FADE = 'fade',
}

/**
 * Supported custom backdrop component position
 */
export enum CUSTOM_BACKDROP_POSITIONS {
  TOP = 'top',
  BEHIND = 'behind',
}

/**
 * Bottom sheet's ref instance methods
 */
export interface BottomSheetMethods {
  /**
   * Expands the bottom sheet to the `height` passed through props
   */
  open(): void;
  /**
   * Collapses the bottom sheet
   */
  close(): void;
}

// short hand for toValue key of animation
type ToValue = Animated.TimingAnimationConfig['toValue'];

/**
 * Main bottom sheet component
 */
const BottomSheet = forwardRef<BottomSheetMethods, BottomSheetProps>(
  (
    {
      backdropMaskColor = DEFAULT_BACKDROP_MASK_COLOR,
      children: Children,
      animationType = DEFAULT_ANIMATION,
      closeOnBackdropPress = true,
      height = DEFAULT_HEIGHT,
      hideHandleBar = false,
      android_backdropMaskRippleColor,
      handleBarStyle,
      disableBodyPanning = false,
      disableHandleBarPanning = false,
      customHandleBarComponent,
      style: contentContainerStyle,
      closeOnDragDown = true,
      containerHeight: passedContainerHeight,
      customBackdropComponent: CustomBackdropComponent,
      customBackdropPosition = CUSTOM_BACKDROP_POSITIONS.BEHIND,
      hideBackdrop = false,
    },
    ref,
  ) => {
    /**
     * ref instance callable methods
     */
    useImperativeHandle(ref, () => ({
      open() {
        openBottomSheet();
      },
      close() {
        closeBottomSheet();
      },
    }));

    /**
     * If passed container height is a valid number we use that as final container height
     * else, it may be a percentage value so then we need to change it to a number (so it can be animated).
     * The change is handled with `onLayout` further down
     */
    const SCREEN_HEIGHT = useWindowDimensions().height; // actual container height is measured after layout
    const [containerHeight, setContainerHeight] = useState(SCREEN_HEIGHT);
    const [sheetOpen, setSheetOpen] = useState(false);

    // animated properties
    const _animatedContainerHeight = useAnimatedValue(0);
    const _animatedBackdropMaskOpacity = useAnimatedValue(0);
    const _animatedHeight = useAnimatedValue(0);
    const _animatedTranslateY = useAnimatedValue(0);

    // Animation utility
    const Animators = useMemo(
      () => ({
        _slideEasingFn(value: number) {
          return value === 1 ? 1 : 1 - Math.pow(2, -10 * value);
        },
        _springEasingFn(value: number) {
          const c4 = (2 * Math.PI) / 2.5;
          return value === 0
            ? 0
            : value === 1
            ? 1
            : Math.pow(2, -9 * value) * Math.sin((value * 4.5 - 0.75) * c4) + 1;
        },
        animateContainerHeight(toValue: ToValue) {
          return Animated.timing(_animatedContainerHeight, {
            toValue: toValue,
            useNativeDriver: false,
            duration: 50,
          });
        },
        animateBackdropMaskOpacity(toValue: ToValue) {
          return Animated.timing(_animatedBackdropMaskOpacity, {
            toValue: toValue,
            useNativeDriver: false,
            duration: 200,
          });
        },
        animateHeight(toValue: ToValue, duration?: number) {
          const DEFAULT_DURATION = duration || 500;
          return Animated.timing(_animatedHeight, {
            toValue,
            useNativeDriver: false,
            duration:
              animationType == ANIMATIONS.SPRING
                ? DEFAULT_DURATION + 100
                : DEFAULT_DURATION,
            easing:
              animationType == ANIMATIONS.SLIDE
                ? this._slideEasingFn
                : this._springEasingFn,
          });
        },
        animateTranslateY(toValue: ToValue) {
          const DEFAULT_DURATION = 500;
          return Animated.timing(_animatedTranslateY, {
            toValue,
            useNativeDriver: false,
            duration: DEFAULT_DURATION,
            easing:
              animationType == ANIMATIONS.SLIDE
                ? this._slideEasingFn
                : this._springEasingFn,
          });
        },
      }),
      [animationType],
    );

    const interpolatedOpacity = useMemo(
      () =>
        animationType == ANIMATIONS.FADE
          ? _animatedBackdropMaskOpacity.interpolate({
              inputRange: [0, 0.5, 1],
              outputRange: [0, 0.3, 1],
              extrapolate: 'clamp',
            })
          : contentContainerStyle?.opacity,
      [animationType, contentContainerStyle],
    );

    /** cached _nativeTag property of content container */
    const cachedContentWrapperNativeTag = useRef<number | undefined>(undefined);

    /**
     * `height` prop converted from percentage e.g `'50%'` to pixel unit e.g `320`,
     * relative to `containerHeight` or `DEVICE_SCREEN_HEIGHT`.
     * Also auto calculates and adjusts container wrapper height when `containerHeight`
     * or `height` changes
     */
    const convertedHeight = useMemo(() => {
      const newHeight = convertHeight(height, containerHeight, hideHandleBar);
      if (sheetOpen) {
        if (animationType == ANIMATIONS.FADE)
          _animatedHeight.setValue(newHeight);
        else Animators.animateHeight(newHeight).start();
      }
      return newHeight;
    }, [containerHeight, height, sheetOpen, animationType]);

    const {removeKeyboardListeners} = useHandleKeyboardEvents(
      convertedHeight,
      sheetOpen,
      Animators.animateHeight,
    );

    /**
     * Returns conditioned gesture handlers for content container and handle bar elements
     */
    const getPanHandlersFor = (view: 'handlebar' | 'contentwrapper') => {
      if (view == 'handlebar' && disableHandleBarPanning) return null;
      if (view == 'contentwrapper' && disableBodyPanning) return null;
      return PanResponder.create({
        onMoveShouldSetPanResponder: (evt, gestureState) => {
          /**
           * `FiberNode._nativeTag` is stable across renders so we use it to determine
           * whether content container or it's child should respond to touch move gesture.
           *
           * The logic is, when content container is laid out, we extract it's _nativeTag property and cache it
           * So later when a move gesture event occurs within it, we compare the cached _nativeTag with the _nativeTag of
           * the event target's _nativeTag, if they match, then content container should respond, else its children should.
           * Also, when the target is the handle bar, we le it handle geture unless panning is disabled through props
           */
          return view == 'handlebar'
            ? true
            : cachedContentWrapperNativeTag.current ==
                // @ts-expect-error
                evt?.target?._nativeTag;
        },
        onPanResponderMove: (e, gestureState) => {
          if (gestureState.dy > 0) {
            // backdrop opacity relative to the height of the content sheet
            // to makes the backdrop more transparent as you drag the content sheet down
            const relativeOpacity = 1 - gestureState.dy / convertedHeight;
            _animatedBackdropMaskOpacity.setValue(relativeOpacity);
            animationType != ANIMATIONS.FADE &&
              _animatedHeight.setValue(convertedHeight - gestureState.dy);
          }
        },
        onPanResponderRelease(e, gestureState) {
          if (gestureState.dy >= convertedHeight / 3 && closeOnDragDown) {
            closeBottomSheet();
          } else {
            _animatedBackdropMaskOpacity.setValue(1);
            animationType != ANIMATIONS.FADE &&
              Animators.animateHeight(convertedHeight).start();
          }
        },
      }).panHandlers;
    };

    /**
     * Polymorphic content container handle bar component
     */
    const PolymorphicHandleBar: React.FunctionComponent<{}> = () => {
      const CustomHandleBar = customHandleBarComponent;
      return hideHandleBar ? null : CustomHandleBar &&
        typeof CustomHandleBar == 'function' ? (
        <View style={{alignSelf: 'center'}} {...getPanHandlersFor('handlebar')}>
          <CustomHandleBar
            _animatedHeight={_animatedHeight}
            _animatedYTranslation={_animatedTranslateY}
          />
        </View>
      ) : (
        <DefaultHandleBar
          style={handleBarStyle}
          {...getPanHandlersFor('handlebar')}
        />
      );
    };

    /**
     * Extracts and caches the _nativeTag property of ContentWrapper
     */
    let extractNativeTag = useCallback(
      // @ts-expect-error
      ({target: {_nativeTag: tag = undefined}}: LayoutChangeEvent) => {
        !cachedContentWrapperNativeTag.current &&
          (cachedContentWrapperNativeTag.current = tag);
      },
      [],
    );

    /**
     * Expands the bottom sheet.
     */
    const openBottomSheet = () => {
      // 1. open container
      // 2. if using fade animation, set content container height convertedHeight manually, animate backdrop.
      // else, animate backdrop and content container height in parallel
      Animators.animateContainerHeight(
        hideBackdrop ? convertedHeight : containerHeight,
      ).start();
      if (animationType == ANIMATIONS.FADE) {
        _animatedHeight.setValue(convertedHeight);
        Animators.animateBackdropMaskOpacity(1).start();
      } else {
        Animators.animateBackdropMaskOpacity(1).start();
        Animators.animateHeight(convertedHeight).start();
      }
      setSheetOpen(true);
    };

    const closeBottomSheet = () => {
      // 1. fade backdrop
      // 2. if using fade animation, close container, set content wrapper height to 0.
      // else animate content container height & container height to 0, in sequence
      Animators.animateBackdropMaskOpacity(0).start(anim => {
        if (anim.finished) {
          if (animationType == ANIMATIONS.FADE) {
            Animators.animateContainerHeight(0).start();
            _animatedHeight.setValue(0);
          } else {
            Animators.animateHeight(0).start();
            Animators.animateContainerHeight(0).start();
          }
        }
      });
      setSheetOpen(false);
      removeKeyboardListeners();
      Keyboard.dismiss();
    };

    const containerViewLayoutHandler = (event: LayoutChangeEvent) => {
      const newHeight = event.nativeEvent.layout.height;
      setContainerHeight(newHeight);
      // incase `containerHeight` prop value changes when bottom sheet is expanded
      // we need to manually update the container height
      if (sheetOpen) _animatedContainerHeight.setValue(newHeight);
    };

    /**
     * Handles auto adjusting container view height and clamping
     * and normalizing `containerHeight` prop upon change, if its a number.
     * Also auto adjusts when orientation changes
     */
    useLayoutEffect(() => {
      if (hideBackdrop) return;
      else {
        if (typeof passedContainerHeight == 'number') {
          setContainerHeight(normalizeHeight(passedContainerHeight));
          if (sheetOpen)
            _animatedContainerHeight.setValue(passedContainerHeight);
        } else if (
          typeof passedContainerHeight == 'undefined' &&
          containerHeight != SCREEN_HEIGHT
        ) {
          setContainerHeight(SCREEN_HEIGHT);
          if (sheetOpen) _animatedContainerHeight.setValue(SCREEN_HEIGHT);
        }
      }
    }, [
      passedContainerHeight,
      SCREEN_HEIGHT,
      sheetOpen,
      containerHeight,
      hideBackdrop,
    ]);

    return (
      <>
        {typeof passedContainerHeight == 'string' ? (
          /**
           * Below View handles converting `passedContainerHeight` from string to a number (to be animatable).
           * It does this by taking the string height passed via `containerHeight` prop,
           * and returning it's numeric equivalent after rendering, via its `onLayout` so we can
           * use that as the final container height.
           */
          <View
            onLayout={containerViewLayoutHandler}
            style={{
              height: passedContainerHeight,
              width: StyleSheet.hairlineWidth,
              backgroundColor: 'red',
            }}
          />
        ) : null}

        {/* Container */}
        <Container style={{height: _animatedContainerHeight}}>
          {/* Backdrop */}
          {hideBackdrop ? null : (
            <Backdrop
              BackdropComponent={CustomBackdropComponent}
              _animatedHeight={_animatedHeight}
              animatedBackdropOpacity={_animatedBackdropMaskOpacity}
              backdropColor={backdropMaskColor}
              backdropPosition={customBackdropPosition}
              closeOnPress={closeOnBackdropPress}
              containerHeight={containerHeight}
              contentContainerHeight={convertedHeight}
              pressHandler={closeBottomSheet}
              rippleColor={android_backdropMaskRippleColor}
              sheetOpen={sheetOpen}
            />
          )}
          {/* content container */}
          <Animated.View
            key={'BottomSheetContentContainer'}
            onLayout={extractNativeTag}
            /**
             * Merge external style and transform property carefully and orderly with
             * internal styles and animated transform properties
             * to apply external styles and transform properties and avoid
             * internal styles and transform properties override
             */
            style={[
              styles.contentContainer,
              contentContainerStyle,
              {
                height: _animatedHeight,
                minHeight: _animatedHeight,
                opacity: interpolatedOpacity,
              },
            ]}
            {...getPanHandlersFor('contentwrapper')}>
            <>
              {/* Content Handle Bar */}
              <PolymorphicHandleBar />
              {typeof Children == 'function' ? (
                <Children _animatedHeight={_animatedHeight} />
              ) : (
                Children
              )}
            </>
          </Animated.View>
        </Container>
      </>
    );
  },
);

const styles = StyleSheet.create({
  contentContainer: {
    backgroundColor: 'white',
    width: '100%',
    overflow: 'hidden',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
});

export default BottomSheet;
